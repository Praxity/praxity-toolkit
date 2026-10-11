import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { fixture, fakeTool, repository } from './helpers.mjs';

async function until(condition, message) {
  for (let attempts = 0; attempts < 250; attempts++) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail(message);
}

for (const early of [false, true]) {
  test(`Windows Studio requests a hidden console and closes IPC after launcher death ${early ? 'before bootstrap' : 'after readiness'}`,
    { skip: process.platform !== 'win32' && 'Windows process ownership', timeout: 10_000 }, async t => {
    let launcher, finished, pid;
    // End owned processes before the fixture removes their markers and course.
    t.after(async () => {
      if (launcher && !launcher.stdout.destroyed && pid) {
        try { process.kill(pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (launcher?.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
      await finished;
    });
    const { context } = fixture(t), ready = join(context.root, 'ready'), closed = join(context.root, 'closed');
    const gate = join(context.root, 'bootstrap-go'), options = join(context.root, 'spawn.json');
    fakeTool(context, 'studio', `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
writeFileSync(process.env.TOOL_READY, JSON.stringify({ pid: process.pid, connected: process.connected ?? null }));
${early ? "while (!existsSync(process.env.TOOL_GATE)) await delay(20);" : ''}
const stop = () => { writeFileSync(process.env.TOOL_CLOSED, '129'); process.exit(129); };
process.on('disconnect', stop);
if (process.connected === false) stop();
setInterval(() => {}, 1000);
`);
    const entry = join(context.root, 'launcher.mjs');
    writeFileSync(entry, `
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
// Observe the OS adapter without replacing its options or the real child.
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  writeFileSync(process.env.TOOL_SPAWN, JSON.stringify({ windowsHide: args[2].windowsHide }));
  return child;
};
syncBuiltinESMExports();
const { executeTool } = await import(${JSON.stringify(pathToFileURL(join(repository, 'src/tools.mjs')).href)});
const pack = JSON.parse(process.env.TOOL_PACK);
const context = { root: process.env.TOOL_ROOT, home: process.env.TOOL_HOME,
  node: process.execPath, pack, state: { installed: ['studio'], platform: 'darwin-arm64' }, env: process.env };
process.exitCode = await executeTool(context, pack.tools.find(tool => tool.id === 'studio'), ['studio', '.', '--no-open']);
`);
    launcher = spawn(process.execPath, [entry], {
      env: { ...process.env, TOOL_ROOT: context.root, TOOL_HOME: context.home, TOOL_PACK: JSON.stringify(context.pack),
        TOOL_READY: ready, TOOL_CLOSED: closed, TOOL_GATE: gate, TOOL_SPAWN: options },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const exited = once(launcher, 'exit');
    finished = once(launcher, 'close');
    await until(() => existsSync(ready), 'Studio did not report readiness');
    const state = JSON.parse(readFileSync(ready, 'utf8'));
    pid = state.pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(state.connected, true);
    launcher.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    if (early) writeFileSync(gate, 'go');
    await until(() => existsSync(closed), 'Studio outlived its launcher without IPC EOF');
    await finished;
    assert.equal(readFileSync(closed, 'utf8'), '129');
    assert.deepEqual(JSON.parse(readFileSync(options, 'utf8')), { windowsHide: true });
  });
}
