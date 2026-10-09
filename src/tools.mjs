import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import { join, delimiter, dirname } from 'node:path';

export const quotePosix = value => `'${value.replaceAll("'", "'\\''")}'`;

function declinedPath(context) {
  const home = realpathSync(context.home), directory = join(home, '.praxity', 'toolkit-state');
  const file = join(directory, 'declined.json');
  for (const path of [join(home, '.praxity'), directory, file]) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Tool state symlink refused: ${path}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return file;
}

export function readDeclined(context) {
  const file = declinedPath(context), state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.values(state).some(components => !Array.isArray(components) || components.some(value => typeof value !== 'string'))) throw new Error(`Invalid tool consent state: ${file}`);
  return state;
}

function recordDeclined(context, tool, components) {
  const file = declinedPath(context), prior = readDeclined(context);
  const bytes = JSON.stringify({ ...prior, [tool]: [...new Set([...(prior[tool] ?? []), ...components])] }) + '\n';
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.declined.${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', flush: true }); created = true;
    declinedPath(context); renameSync(temp, file);
  } finally {
    if (created && existsSync(temp) && readFileSync(temp, 'utf8') === bytes) unlinkSync(temp);
  }
}

export function toolInvocation(context, tool, args) {
  const directory = join(context.root, 'tools', tool.id);
  const entry = join(directory, tool.entry);
  if (!context.state.installed.includes(tool.id) || !existsSync(entry)) throw new Error(`${tool.id} is not installed. Run the reviewed install.sh after its archive is published.`);
  const env = toolEnvironment(context);
  // Studio can detect launcher death even before its first parent-PID snapshot.
  if (tool.id === 'studio' && process.platform !== 'win32') env.PRAXITY_PARENT_PID = String(process.pid);
  return { command: tool.runner === 'node' ? context.node : entry,
    args: tool.runner === 'node' ? [entry, ...args] : args, env };
}

export function toolEnvironment(context) {
  const typst = join(context.root, 'runtimes/typst', context.pack.runtimes.typst.entry[context.state.platform]);
  const studio = context.pack.tools.find(tool => tool.id === 'studio');
  // Import's verifier needs Studio alone, rather than the umbrella dispatcher.
  const studioLauncher = join(context.root, 'bin', 'praxity-studio');
  const env = { ...context.env,
    PATH: [join(context.root, 'bin'), join(context.root, 'runtimes/node/bin'), context.env.PATH ?? ''].join(delimiter),
    PRAXITY_PRINT_TYPST: typst,
    ...(studio ? { PRAXITY_CLI: studioLauncher } : {}),
  };
  // A parent identity belongs to one direct spawn, never an inherited tool chain.
  delete env.PRAXITY_PARENT_PID;
  return env;
}

export function probeProcess({ command, args, env }, options = {}) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, ...options });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
}

export async function executeTool(context, tool, args) {
  const invocation = toolInvocation(context, tool, args);
  const setup = args[0] === tool.setup?.[0];
  // Stopping the launcher stops the tool, and the launcher exits only after
  // the tool has. Other tools run detached: Node calls setsid(), so each gets
  // a new session without the terminal as its controlling terminal. Ctrl+C
  // and Ctrl+\ then reach only the launcher, which forwards them once: Studio
  // stops on its first signal and dies on a second. Ctrl+Z suspends only the
  // launcher; the tool keeps running. Setup keeps the terminal for its consent
  // prompts, so the terminal's signals already reach it. Windows has neither.
  const child = spawn(invocation.command, invocation.args, { env: invocation.env,
    detached: !setup && process.platform !== 'win32', stdio: ['inherit', setup ? 'pipe' : 'inherit', 'inherit'] });
  let output = '';
  if (setup) child.stdout.on('data', bytes => {
    process.stdout.write(bytes);
    output = (output + bytes.toString()).slice(-1024 * 1024);
  });
  const forward = signal => { if (!setup || !['SIGINT', 'SIGQUIT'].includes(signal)) child.kill(signal); };
  const signals = ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, forward);
  // Once the tool has exited there is nothing to forward to, and the launcher
  // stops on the next signal even while a grandchild holds the tool's output.
  const release = () => { for (const signal of signals) process.off(signal, forward); };
  child.once('exit', release);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      // A tool ended by a signal exits 128 plus its number, as a shell reports it.
      child.on('close', (code, signal) => resolve(signal ? 128 + constants.signals[signal] : code));
    });
  } finally { release(); }
  if (setup && tool.id === 'check') {
    // Check currently exposes refusal in setup's text result, not doctor JSON.
    // Record only its explicit refusal line; never classify a missing component
    // as declined. Replace this adapter when Check persists consent itself.
    const refused = [...output.matchAll(/(?:^|\n)(browser|java|verapdf): declined; dependent checks will report not run/g)].map(match => match[1]);
    if (refused.length) recordDeclined(context, tool.id, refused);
  }
  return code;
}
