import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';

export const quotePosix = value => `'${value.replaceAll("'", "'\\''")}'`;

export function toolInvocation(context, tool, args) {
  const directory = join(context.root, 'tools', tool.id);
  const entry = join(directory, tool.entry);
  if (!context.state.installed.includes(tool.id) || !existsSync(entry)) throw new Error(`${tool.id} is not installed. Run the reviewed install.sh after its archive is published.`);
  return { command: tool.runner === 'node' ? context.node : entry,
    args: tool.runner === 'node' ? [entry, ...args] : args, env: toolEnvironment(context) };
}

export function toolEnvironment(context) {
  const typst = join(context.root, 'runtimes/typst', context.pack.runtimes.typst.entry[context.state.platform]);
  const studio = context.pack.tools.find(tool => tool.id === 'studio');
  // Import's verifier needs Studio alone, rather than the umbrella dispatcher.
  const studioLauncher = join(context.root, 'bin', 'praxity-studio');
  return { ...context.env,
    PATH: [join(context.root, 'bin'), join(context.root, 'runtimes/node/bin'), context.env.PATH ?? ''].join(delimiter),
    PRAXITY_PRINT_TYPST: typst,
    ...(studio ? { PRAXITY_CLI: studioLauncher } : {}),
  };
}

export function probeProcess({ command, args, env }, options = {}) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, ...options });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
}

export async function executeTool(context, tool, args) {
  const invocation = toolInvocation(context, tool, args);
  const setup = args[0] === tool.setup?.[0];
  const child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ['inherit', setup ? 'pipe' : 'inherit', 'inherit'] });
  let output = '';
  if (setup) child.stdout.on('data', bytes => {
    process.stdout.write(bytes);
    output = (output + bytes.toString()).slice(-1024 * 1024);
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => signal ? reject(new Error(`${tool.id} stopped by ${signal}`)) : resolve(code));
  });
  if (setup && tool.id === 'check') {
    // Check currently exposes refusal in setup's text result, not doctor JSON.
    // Record only its explicit refusal line; never classify a missing component
    // as declined. Replace this adapter when Check persists consent itself.
    const refused = [...output.matchAll(/(?:^|\n)(browser|java|verapdf): declined; dependent checks will report not run/g)].map(match => match[1]);
    if (refused.length) {
      const file = join(context.root, 'declined.json');
      const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
      writeFileSync(file, JSON.stringify({ ...prior, check: [...new Set([...(prior.check ?? []), ...refused])] }) + '\n');
    }
  }
  return code;
}
