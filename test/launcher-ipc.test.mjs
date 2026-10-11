import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, fakeTool, repository } from './helpers.mjs';
import { executeTool, toolInvocation } from '../src/tools.mjs';

async function until(condition, message, limit = 10_000) {
  const deadline = Date.now() + limit;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await delay(20);
  }
}

async function reservePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('invocation does not mutate or inherit a parent identity, including synchronous Studio probes', t => {
  const { context } = fixture(t);
  context.env = { ...context.env, PRAXITY_PARENT_PID: '999999' };
  for (const id of ['studio', 'check', 'trace', 'print', 'import']) {
    const tool = fakeTool(context, id);
    assert.equal(toolInvocation(context, tool, []).env.PRAXITY_PARENT_PID, undefined, id);
  }
  assert.equal(context.env.PRAXITY_PARENT_PID, '999999');
});

test('only the direct Studio child receives IPC; its descendants and the launcher retain no PID identity', async t => {
  const { context } = fixture(t), result = join(context.root, 'identity.json');
  context.env = { ...context.env, PRAXITY_PARENT_PID: '999999', TEST_IDENTITY: result };
  const tool = fakeTool(context, 'studio', `
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const descendant = JSON.parse(spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({connected:process.connected??null,parent:process.env.PRAXITY_PARENT_PID??null}))'], { encoding: 'utf8' }).stdout);
writeFileSync(process.env.TEST_IDENTITY, JSON.stringify({ connected: process.connected ?? null, parent: process.env.PRAXITY_PARENT_PID ?? null, descendant }));
if (process.connected) process.disconnect();
`);
  assert.equal(await executeTool(context, tool, ['studio', '--help']), 0);
  assert.deepEqual(JSON.parse(readFileSync(result)), { connected: true, parent: null, descendant: { connected: null, parent: null } });
  assert.equal(context.env.PRAXITY_PARENT_PID, '999999');
});

const posixOnly = { skip: process.platform === 'win32' && 'POSIX hard-kill lifecycle; Windows IPC identity is tested separately' };
test('an executable Studio fallback receives only its direct launcher PID', posixOnly, async t => {
  const { context } = fixture(t), result = join(context.root, 'identity.json');
  context.env = { ...context.env, PRAXITY_PARENT_PID: '999999', TEST_IDENTITY: result };
  const tool = fakeTool(context, 'studio', `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.TEST_IDENTITY, JSON.stringify({ connected: process.connected ?? null, parent: process.env.PRAXITY_PARENT_PID }));
`);
  tool.runner = 'exec';
  chmodSync(join(context.root, 'tools/studio', tool.entry), 0o755);
  assert.equal(await executeTool(context, tool, ['studio', '--help']), 0);
  assert.deepEqual(JSON.parse(readFileSync(result)), { connected: null, parent: String(process.pid) });
  assert.equal(context.env.PRAXITY_PARENT_PID, '999999');
});

for (const immediate of [true, false]) test(`IPC closes Studio cleanly when its launcher dies ${immediate ? 'immediately after spawn' : 'after readiness'}`, posixOnly, async t => {
  const { context } = fixture(t), port = await reservePort();
  const ready = join(context.root, 'ready.json'), stopped = join(context.root, 'closed.json');
  const exitedFile = join(context.root, 'exit.json'), pidFile = join(context.root, 'child.pid');
  const gate = join(context.root, 'bootstrap-go'), entered = join(context.root, 'bootstrap-entered');
  const preloader = join(context.root, 'preload.mjs'), driver = join(context.root, 'launcher.mjs');
  const source = process.env.TOOLKIT_STUDIO_ENTRY;
  const tool = fakeTool(context, 'studio', source ? '' : `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const descendant = JSON.parse(spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({connected:process.connected??null,parent:process.env.PRAXITY_PARENT_PID??null}))'], { encoding: 'utf8' }).stdout);
let server, stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  const done = () => { writeFileSync(process.env.TEST_CLOSED, JSON.stringify({ code: 129, clean: true })); process.exit(129); };
  if (server) server.close(done); else done();
};
if (process.connected !== undefined) {
  process.on('disconnect', stop);
  if (!process.connected) stop();
}
server = createServer((request, response) => response.end('Studio'));
server.listen(Number(process.env.TEST_PORT), '127.0.0.1', () => {
  writeFileSync(process.env.TEST_READY, JSON.stringify({ pid: process.pid, connected: process.connected ?? null, parent: process.env.PRAXITY_PARENT_PID ?? null, descendant }));
  console.log('studio-ready');
});
`);
  if (source) tool.entry = relative(join(context.root, 'tools/studio'), source);
  writeFileSync(join(context.cwd, 'lesson.prax'), '---\ntitle: Test\n---\n# Hello\n');
  writeFileSync(preloader, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
while (!existsSync(process.env.TEST_PID)) await delay(20);
if (Number(readFileSync(process.env.TEST_PID, 'utf8')) === process.pid) {
process.on('exit', code => writeFileSync(process.env.TEST_EXIT, JSON.stringify({ code })));
if (process.env.TEST_EARLY === '1') {
  writeFileSync(process.env.TEST_ENTERED, String(process.pid));
  while (!existsSync(process.env.TEST_GATE)) await delay(20);
}
const close = Server.prototype.close;
Server.prototype.close = function(...args) {
  this.once('close', () => writeFileSync(process.env.TEST_CLOSED, JSON.stringify({ clean: true })));
  return close.apply(this, args);
};
syncBuiltinESMExports();
}
`);
  // Observe the real OS spawn, then kill the launcher before the gated bootstrap.
  // No toolkit function, child option or Studio close implementation is replaced.
  writeFileSync(driver, `
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  writeFileSync(process.env.TEST_PID, String(child.pid));
  if (process.env.TEST_EARLY === '1') process.kill(process.pid, 'SIGKILL');
  return child;
};
syncBuiltinESMExports();
const { runCli } = await import(${JSON.stringify(pathToFileURL(join(repository, 'src/cli.mjs')).href)});
const context = ${JSON.stringify({ ...context, env: undefined })};
context.env = { ...process.env, NODE_OPTIONS: ${JSON.stringify(`--import=${pathToFileURL(preloader).href}`)} };
process.exitCode = await runCli(['studio', process.env.TEST_COURSE ?? '.', '--no-open', '--port', process.env.TEST_PORT], context);
`);
  const launcher = spawn(process.execPath, [driver], {
    cwd: context.root,
    env: { ...process.env, HOME: context.home, USERPROFILE: context.home, PRAXITY_PARENT_PID: '999999', TEST_EARLY: immediate ? '1' : '0', TEST_PID: pidFile,
      TEST_COURSE: context.cwd, TEST_PORT: String(port), TEST_READY: ready, TEST_CLOSED: stopped, TEST_EXIT: exitedFile, TEST_ENTERED: entered, TEST_GATE: gate },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', stderr = '';
  launcher.stdout.on('data', bytes => { output += bytes; });
  launcher.stderr.on('data', bytes => { stderr += bytes; });
  const exited = once(launcher, 'exit'), closed = once(launcher, 'close');
  let studioPid;
  t.after(() => {
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
    if (studioPid !== undefined) {
      try { process.kill(studioPid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  await until(() => existsSync(pidFile), 'Studio was not spawned');
  studioPid = Number(readFileSync(pidFile, 'utf8'));
  if (immediate) {
    assert.deepEqual(await exited, [null, 'SIGKILL']);
    await until(() => existsSync(entered), 'Studio did not reach its gated preload');
    assert.equal(existsSync(ready), false);
    writeFileSync(gate, 'continue');
  } else {
    await until(() => source ? output.includes('#session=') : existsSync(ready), 'Studio did not become ready');
    const response = await fetch(`http://127.0.0.1:${port}/launch`);
    assert.equal(response.status, 200);
    await response.text();
    if (!source) {
      const identity = JSON.parse(readFileSync(ready));
      assert.equal(identity.connected, true);
      assert.equal(identity.parent, null);
      assert.deepEqual(identity.descendant, { connected: null, parent: null });
    }
    launcher.kill('SIGKILL');
    assert.deepEqual(await exited, [null, 'SIGKILL']);
  }
  await until(() => existsSync(exitedFile), 'Studio outlived its launcher');
  assert.equal(JSON.parse(readFileSync(exitedFile)).code, 129);
  if (!immediate) assert.equal(JSON.parse(readFileSync(stopped)).clean, true);
  assert.equal(stderr, '');
  await until(() => launcher.stdout.destroyed && launcher.stderr.destroyed, 'Studio retained its inherited output handles');
  await closed;
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
