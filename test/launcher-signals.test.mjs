import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installation, archive } from './installer-fixture.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(condition, message) {
  for (let waited = 0; !condition(); waited += 100) {
    if (waited > 30_000) assert.fail(message);
    await delay(100);
  }
}

// Windows has no POSIX signals; CI runs this on Ubuntu and macOS.
test('stopping the launcher with SIGTERM stops Studio and frees its port', { skip: process.platform === 'win32' && 'POSIX signals only' }, async t => {
  const setup = installation(t), studio = join(setup.root, 'fake studio'), ready = join(setup.root, 'studio.json');
  writeFileSync(join(studio, 'praxity.mjs'), `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const server = createServer((request, response) => response.end('studio'));
server.listen(0, '127.0.0.1', () => writeFileSync(process.env.STUDIO_READY, JSON.stringify({ pid: process.pid, port: server.address().port })));
`);
  setup.pack.tools.find(tool => tool.id === 'studio').archives['darwin-arm64'] = archive(studio, join(setup.root, 'studio archive.tar.gz'));
  setup.save();
  const installed = setup.install(); assert.equal(installed.status, 0, installed.stderr);
  const launcher = spawn(join(setup.home, '.praxity/bin/praxity'), ['studio', '.', '--no-open'],
    { cwd: setup.root, env: { ...setup.env, STUDIO_READY: ready }, stdio: 'ignore' });
  const exited = once(launcher, 'exit');
  let pid;
  // Runs before the fixture's own cleanup removes the temporary home.
  t.after(() => {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
  });
  await until(() => existsSync(ready), 'Studio did not start');
  const { port } = JSON.parse(readFileSync(ready, 'utf8'));
  pid = JSON.parse(readFileSync(ready, 'utf8')).pid;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'studio');
  launcher.kill('SIGTERM');
  await exited;
  await until(() => !alive(pid), 'Studio outlived its launcher');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});
