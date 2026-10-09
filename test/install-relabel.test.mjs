import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installation, posix, quote, shell, crashAfter, replaceInstalled } from './installer-fixture.mjs';

const passed = result => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = name => readFileSync(new URL(`./fixtures/mislabeled/v0.1.0-${name}.pack.json`, import.meta.url));
const pointers = setup => readFileSync(join(setup.toolkit, 'active'), 'utf8');

// Makes the installed 0.1.0 pack look as if a release candidate's manifest had
// installed it: its manifest, state and journal agree on the candidate's bytes.
function installCandidate(setup, bytes) {
  passed(setup.install());
  replaceInstalled(setup, '0.1.0', 'pack.json', bytes);
}
function launchedPack(setup) {
  const result = shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} version`, { env: setup.env });
  passed(result);
  return JSON.parse(result.stdout).pack;
}

for (const name of ['rc.1', 'rc.2']) test(`installing 0.1.0 moves an active ${name} pack labelled 0.1.0 aside, and rollback reaches it`, t => {
  const setup = installation(t, { tool: false }), bytes = candidate(name);
  installCandidate(setup, bytes);
  const result = setup.install(); passed(result);
  assert.match(result.stdout, /Moved release candidate 0\.1\.0-rc\.1/);
  assert.equal(pointers(setup), '0.1.0\n0.1.0-rc.1\n');
  assert.deepEqual(readFileSync(join(setup.toolkit, '0.1.0-rc.1/pack.json')), bytes);
  assert.equal(JSON.parse(readFileSync(join(setup.toolkit, '0.1.0/state.json'), 'utf8')).manifestSha256, digest(readFileSync(setup.manifest)));
  passed(setup.action('rollback'));
  assert.equal(pointers(setup), '0.1.0-rc.1\n0.1.0\n');
  assert.equal(launchedPack(setup), '0.1.0');
  passed(setup.action('uninstall'));
  assert.equal(existsSync(join(setup.toolkit, '0.1.0-rc.1')), false);
});

test('installing a later candidate moves a mislabeled one aside too, and 0.1.0 then installs beside both', t => {
  const setup = installation(t, { tool: false });
  installCandidate(setup, candidate('rc.2'));
  setup.pack.version = '0.1.0-rc.3'; setup.save();
  const result = setup.install(); passed(result);
  assert.match(result.stdout, /Moved release candidate 0\.1\.0-rc\.1/);
  assert.equal(pointers(setup), '0.1.0-rc.3\n0.1.0-rc.1\n');
  setup.pack.version = '0.1.0'; setup.save(); passed(setup.install());
  assert.equal(pointers(setup), '0.1.0\n0.1.0-rc.3\n');
  assert.ok(existsSync(join(setup.toolkit, '0.1.0-rc.1/state.json')));
  passed(setup.action('rollback'));
  assert.equal(launchedPack(setup), '0.1.0-rc.3');
});

for (const boundary of ['pointer rewrite', 'folder move']) for (const version of ['0.1.0', '0.1.0-rc.3']) test(`a ${version} rerun finishes a candidate move killed after its ${boundary}`, t => {
  const setup = installation(t, { tool: false });
  installCandidate(setup, candidate('rc.2'));
  const marker = crashAfter(setup, 'mv', `case "$*" in ${boundary === 'folder move' ? '*/toolkit/0.1.0-rc.1' : '*/toolkit/active'}) touch ${quote(posix(join(setup.root, 'crashed')))}; kill -KILL "$PPID";; esac`);
  const killed = setup.install(); assert.notEqual(killed.status, 0); assert.ok(existsSync(marker), killed.stderr);
  // The shell journal walks trees with find. The rerun's journal is a Node.
  const walks = join(setup.root, 'find.log');
  writeFileSync(join(setup.root, 'crash-bin/find'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(posix(walks))}\nexec ${quote(shell('command -v find').stdout.trim())} "$@"\n`, { mode: 0o755 });
  setup.pack.version = version; setup.save();
  passed(setup.install());
  assert.doesNotMatch(existsSync(walks) ? readFileSync(walks, 'utf8') : '', /\.bootstrap-/);
  assert.equal(pointers(setup), `${version}\n0.1.0-rc.1\n`);
  passed(setup.action('rollback'));
  assert.equal(launchedPack(setup), '0.1.0');
  passed(setup.action('uninstall'));
});

test('a 0.1.0 folder holding any other manifest is still refused unchanged', t => {
  const setup = installation(t, { tool: false });
  const altered = Buffer.concat([candidate('rc.2'), Buffer.from('\n')]);
  installCandidate(setup, altered);
  const result = setup.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pack version already exists with a different manifest/);
  assert.deepEqual(readFileSync(join(setup.toolkit, '0.1.0/pack.json')), altered);
  assert.equal(existsSync(join(setup.toolkit, '0.1.0-rc.1')), false);
  assert.equal(pointers(setup), '0.1.0\n\n');
});

// Each refusal leaves the candidate in its folder, unchanged.
function refused(setup, result, message) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
  assert.equal(JSON.parse(readFileSync(join(setup.toolkit, '0.1.0/state.json'), 'utf8')).manifestSha256, digest(candidate('rc.2')));
}

test('a candidate whose name is already installed is refused', t => {
  const setup = installation(t, { tool: false });
  setup.pack.version = '0.1.0-rc.1'; setup.save(); passed(setup.install());
  setup.pack.version = '0.1.0'; setup.save();
  installCandidate(setup, candidate('rc.2'));
  const before = readFileSync(join(setup.toolkit, '0.1.0-rc.1/state.json'));
  refused(setup, setup.install(), /holds release candidate 0\.1\.0-rc\.1, which is also installed/);
  assert.deepEqual(readFileSync(join(setup.toolkit, '0.1.0-rc.1/state.json')), before);
  assert.equal(pointers(setup), '0.1.0\n0.1.0-rc.1\n');
});

for (const [damage, change, message] of [
  ['a changed file', folder => appendFileSync(join(folder, 'launcher.sh'), '# edited\n'), /damaged or owned file changed/],
  ['a missing pack.json', folder => rmSync(join(folder, 'pack.json')), /0\.1\.0 holds early release candidate 0\.1\.0-rc\.1, and it is damaged\. Installed file damaged: pack\.json\. Every install stops here until you move it aside\. Follow the backup steps under Recovery/],
  ['a user-added file', folder => writeFileSync(join(folder, 'notes.txt'), 'mine'), /unowned path preserved/],
]) test(`a candidate with ${damage} is refused, not moved`, t => {
  const setup = installation(t, { tool: false });
  installCandidate(setup, candidate('rc.2'));
  change(join(setup.toolkit, '0.1.0'));
  const result = setup.install();
  refused(setup, result, message);
  // The install journal refuses the other two damages before the candidate check.
  if (damage === 'a missing pack.json') assert.doesNotMatch(result.stderr, /Roll back|\n\s+at /);
  assert.equal(existsSync(join(setup.toolkit, '0.1.0-rc.1')), false);
  assert.equal(pointers(setup), '0.1.0\n\n');
});

// Lists processes with POSIX ps; CI runs this on Ubuntu and macOS.
test('a candidate in use is refused until its processes stop', { skip: process.platform === 'win32' && 'POSIX ps only' }, async t => {
  const setup = installation(t, { tool: false });
  installCandidate(setup, candidate('rc.2'));
  const running = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(setup.toolkit, '0.1.0/src/cli.mjs')], { stdio: 'ignore' });
  t.after(() => running.kill('SIGKILL'));
  const result = setup.install();
  refused(setup, result, /Pack 0\.1\.0 is in use by these processes:\n.*\nClose Studio and stop the other processes listed, then rerun\./);
  assert.match(result.stderr, new RegExp(`^ *${running.pid} .*/0\\.1\\.0/src/cli\\.mjs$`, 'm'));
  assert.equal(existsSync(join(setup.toolkit, '0.1.0-rc.1')), false);
  assert.equal(pointers(setup), '0.1.0\n\n');
  running.kill('SIGKILL'); await once(running, 'exit');
  passed(setup.install());
  assert.equal(pointers(setup), '0.1.0\n0.1.0-rc.1\n');
});
