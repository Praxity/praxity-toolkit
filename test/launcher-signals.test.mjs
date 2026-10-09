import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installation, archive } from './installer-fixture.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(condition, message, limit = 30_000) {
  for (let waited = 0; !condition(); waited += 100) {
    if (waited > limit) assert.fail(message);
    await delay(100);
  }
}
const posixOnly = { skip: process.platform === 'win32' && 'POSIX signals only' };

// Installs a pack whose tool entry is the given source, then starts the
// launcher as its own process group, as a terminal's foreground job is.
function launch(t, id, source, args, env = {}) {
  const setup = installation(t, { tools: ['studio', 'check'] }), tool = setup.pack.tools.find(tool => tool.id === id);
  const payload = join(setup.root, `fake ${id}`), ready = join(setup.root, 'ready'), closed = join(setup.root, 'closed');
  writeFileSync(join(payload, tool.entry), source);
  tool.archives['darwin-arm64'] = archive(payload, join(setup.root, `${id} archive.tar.gz`));
  setup.save();
  const installed = setup.install(); assert.equal(installed.status, 0, installed.stderr);
  const launcher = spawn(join(setup.home, '.praxity/bin/praxity'), args,
    { cwd: setup.root, env: { ...setup.env, ...env, TOOL_READY: ready, TOOL_CLOSED: closed }, stdio: 'ignore', detached: true });
  const exited = once(launcher, 'exit');
  const pids = [];
  // Runs before the fixture's own cleanup removes the temporary home.
  t.after(() => {
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
  });
  const started = async () => {
    await until(() => existsSync(ready), `${id} did not start`);
    const state = JSON.parse(readFileSync(ready, 'utf8'));
    pids.push(state.pid);
    return state;
  };
  return { launcher, exited, started, closed };
}

// Studio's standalone CLI stops on its first SIGINT or SIGTERM, removes both
// listeners, and takes a moment to close its server. A second signal kills it.
const studio = `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const server = createServer((request, response) => response.end('studio'));
const stop = () => {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  setTimeout(() => server.close(() => writeFileSync(process.env.TOOL_CLOSED, 'closed')), 500);
};
if (process.env.STUDIO_HANDLES_SIGNALS) { process.once('SIGINT', stop); process.once('SIGTERM', stop); }
server.listen(0, '127.0.0.1', () => writeFileSync(process.env.TOOL_READY, JSON.stringify({ pid: process.pid, port: server.address().port })));
`;

test('stopping the launcher with SIGTERM stops Studio, frees its port and reports the signal', posixOnly, async t => {
  const { launcher, exited, started } = launch(t, 'studio', studio, ['studio', '.', '--no-open']);
  const { pid, port } = await started();
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'studio');
  launcher.kill('SIGTERM');
  assert.deepEqual(await exited, [128 + 15, null]);
  await until(() => !alive(pid), 'Studio outlived its launcher');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});

test('Ctrl+C in a terminal reaches Studio once, so it closes cleanly', posixOnly, async t => {
  const { launcher, exited, started, closed } = launch(t, 'studio', studio, ['studio', '.', '--no-open'], { STUDIO_HANDLES_SIGNALS: '1' });
  const { pid } = await started();
  process.kill(-launcher.pid, 'SIGINT');
  assert.deepEqual(await exited, [0, null]);
  assert.equal(alive(pid), false);
  assert.ok(existsSync(closed), 'Studio was killed before it closed');
});

test('Ctrl+C during setup reaches the tool once', posixOnly, async t => {
  const { launcher, exited, started, closed } = launch(t, 'check', `import { writeFileSync } from 'node:fs';
process.once('SIGINT', () => setTimeout(() => { writeFileSync(process.env.TOOL_CLOSED, 'closed'); process.exit(0); }, 500));
setInterval(() => {}, 1000);
writeFileSync(process.env.TOOL_READY, JSON.stringify({ pid: process.pid }));
`, ['setup', 'check']);
  await started();
  process.kill(-launcher.pid, 'SIGINT');
  assert.deepEqual(await exited, [0, null]);
  assert.ok(existsSync(closed), 'Setup was killed by a second SIGINT');
});

test('after setup exits, a signal stops the launcher even while a grandchild holds its output', posixOnly, async t => {
  const { launcher, exited, started } = launch(t, 'check', `import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true });
writeFileSync(process.env.TOOL_READY, JSON.stringify({ pid: holder.pid }));
process.exit(0);
`, ['setup', 'check']);
  await started();
  // Lets the launcher see setup's exit before the signal arrives.
  await delay(1000);
  launcher.kill('SIGTERM');
  const stopped = await Promise.race([exited, delay(10_000, 'still running')]);
  assert.deepEqual(stopped, [null, 'SIGTERM']);
});
