import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { readManifest } from './manifest.mjs';
import { doctor } from './doctor.mjs';
import { executeTool, probeProcess, quotePosix } from './tools.mjs';
import { buildAdapters, installSkills, refreshSkills, uninstallSkills } from './skills.mjs';
import { initCourse } from './init.mjs';

export function loadContext(root = fileURLToPath(new URL('..', import.meta.url))) {
  const pack = readManifest(join(root, 'pack.json'));
  const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
  if (state.owner !== 'praxity-toolkit' || !pack.platforms.includes(state.platform) || !Array.isArray(state.installed)) throw new Error('Invalid installed pack state');
  return { root, pack, state, node: join(root, 'runtimes/node', pack.runtimes.node.entry[state.platform]), env: process.env, home: homedir(), cwd: process.cwd() };
}

export async function runCli(args, context, dependencies = {}) {
  const execute = dependencies.execute ?? executeTool;
  const print = dependencies.print ?? console.log;
  const [command, ...rest] = args;
  if (command === 'init') {
    if (rest.length > 1 || rest[0]?.startsWith('-')) throw new Error('Usage: praxity init [folder]');
    const result = initCourse({ folder: resolve(context.cwd, rest[0] ?? '.'), home: context.home });
    print(`Updated ${result.file}. Studio uses port ${result.port}.`);
    return 0;
  }
  if (command === 'version') {
    if (rest.length) throw new Error('Usage: praxity version');
    print(JSON.stringify({ pack: context.pack.version, runtimes: Object.fromEntries(Object.entries(context.pack.runtimes).map(([id, runtime]) => [id, runtime.version])), tools: context.pack.tools.map(tool => ({ id: tool.id, version: tool.version, installed: context.state.installed.includes(tool.id) })) }, null, 2));
    return 0;
  }
  if (command === 'doctor') {
    if (rest.some(arg => arg !== '--json') || rest.length > 1) throw new Error('Usage: praxity doctor [--json]');
    const result = (dependencies.doctor ?? doctor)(context);
    print(rest.includes('--json') ? JSON.stringify(result, null, 2) : result.items.map(item => `${item.id}: ${item.status} | ${item.message}${item.fix ? ` | fix: ${item.fix}` : ''}`).join('\n'));
    return result.exitCode;
  }
  if (command === 'rollback') {
    if (rest.length) throw new Error('Usage: praxity rollback');
    const result = (dependencies.rollback ?? probeProcess)({ command: 'sh', args: [join(context.root, 'install.sh'), 'rollback'], env: context.env }, { stdio: 'inherit', timeout: 30_000 });
    if (result.error) throw new Error(result.error);
    return result.code ?? 1;
  }
  if (command === 'skills') {
    if (!['install', 'uninstall', 'refresh'].includes(rest[0])) throw new Error('Usage: praxity skills install|uninstall --host t3|claude|codex --scope user|project, or praxity skills refresh --scope user|project');
    const { values, positionals } = parseArgs({ args: rest.slice(1), allowPositionals: true, options: { host: { type: 'string' }, scope: { type: 'string' } } });
    if (positionals.length || !['user', 'project'].includes(values.scope) || (rest[0] === 'refresh' ? values.host !== undefined : !['t3', 'claude', 'codex'].includes(values.host))) throw new Error('Specify a valid --host and --scope');
    const tools = context.pack.tools.flatMap(tool => {
      const path = join(context.root, 'tools', tool.id, tool.skillPath ?? 'skill');
      return context.state.installed.includes(tool.id) && existsSync(path) ? [path] : [];
    });
    const outputs = buildAdapters({ source: join(context.root, 'skills'), tools, packVersion: context.pack.version });
    if (rest[0] === 'refresh') {
      const result = refreshSkills({ base: values.scope === 'user' ? context.home : context.cwd, outputs });
      if (result.legacyHost) print(`Skills at ${values.scope} scope use an older ownership record and were not refreshed. Stop host sessions, then run praxity skills install --host ${result.legacyHost} --scope ${values.scope}.`);
      else print(result.hosts.length ? `Refreshed ${result.hosts.join(', ')} skills at ${values.scope} scope. Restart the host to load them.` : `No toolkit skills are installed at ${values.scope} scope.`);
      return 0;
    }
    const result = (rest[0] === 'install' ? installSkills : uninstallSkills)({ base: values.scope === 'user' ? context.home : context.cwd,
      otherBase: values.scope === 'user' ? context.cwd : context.home, host: values.host, outputs });
    print(`${rest[0] === 'install' ? 'Installed' : 'Removed'} ${result.host} skills at ${values.scope} scope. Active adapters: ${result.hosts.join(', ') || 'none'}. Restart the host and verify invocation.`);
    return 0;
  }
  if (command === 'setup') {
    const selected = rest[0] ? context.pack.tools.filter(tool => tool.id === rest[0]) : context.pack.tools.filter(tool => context.state.installed.includes(tool.id) && tool.setup);
    if (rest[0] && !selected.length) throw new Error(`Unknown tool: ${rest[0]}`);
    let code = 0;
    for (const tool of selected) {
      if (!tool.setup) { print(`${tool.id}: no tool-owned setup command`); continue; }
      const result = await execute(context, tool, [...tool.setup, ...rest.slice(1)]);
      if (result !== 0) code = result;
    }
    if (!selected.length) print('No installed tools have setup commands.');
    return code;
  }
  const tool = context.pack.tools.find(tool => tool.id === (['check', 'trace', 'print', 'import'].includes(command) ? command : 'studio'));
  if (!tool) throw new Error('Studio is absent from the manifest');
  return execute(context, tool, tool.id === 'studio' ? args : rest);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runCli(process.argv.slice(2), loadContext()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
