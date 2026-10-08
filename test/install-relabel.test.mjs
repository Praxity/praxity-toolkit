import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installation, posix, quote, shell, crashAfter } from './installer-fixture.mjs';

const passed = result => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = name => readFileSync(new URL(`./fixtures/mislabeled/v0.1.0-${name}.pack.json`, import.meta.url));
const pointers = setup => readFileSync(join(setup.toolkit, 'active'), 'utf8');

// Makes the installed 0.1.0 pack look as if a release candidate's manifest had
// installed it: its manifest, state and journal agree on the candidate's bytes.
function installCandidate(setup, bytes) {
  passed(setup.install());
  const folder = join(setup.toolkit, '0.1.0'), stateFile = join(folder, 'state.json');
  writeFileSync(join(folder, 'pack.json'), bytes);
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.manifestSha256 = state.files['pack.json'] = digest(bytes);
  const stateBytes = JSON.stringify(state, null, 2) + '\n';
  writeFileSync(stateFile, stateBytes);
  appendFileSync(join(setup.toolkit, '.install-ledger.tsv'),
    `F\t${digest(bytes)}\t.praxity/toolkit/0.1.0/pack.json\nF\t${digest(stateBytes)}\t.praxity/toolkit/0.1.0/state.json\n`);
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

test('installing 0.1.0 beside rc.3 renames the older candidate in the rollback pointer', t => {
  const setup = installation(t, { tool: false });
  installCandidate(setup, candidate('rc.2'));
  setup.pack.version = '0.1.0-rc.3'; setup.save(); passed(setup.install());
  assert.equal(pointers(setup), '0.1.0-rc.3\n0.1.0\n');
  setup.pack.version = '0.1.0'; setup.save(); passed(setup.install());
  assert.equal(pointers(setup), '0.1.0\n0.1.0-rc.3\n');
  assert.ok(existsSync(join(setup.toolkit, '0.1.0-rc.1/state.json')));
  passed(setup.action('rollback'));
  assert.equal(launchedPack(setup), '0.1.0-rc.3');
});

for (const boundary of ['pointer rewrite', 'folder move']) test(`rerun finishes a candidate move killed after its ${boundary}`, t => {
  const setup = installation(t, { tool: false });
  installCandidate(setup, candidate('rc.2'));
  const marker = crashAfter(setup, 'mv', `case "$*" in ${boundary === 'folder move' ? '*/toolkit/0.1.0-rc.1' : '*/toolkit/active'}) touch ${quote(posix(join(setup.root, 'crashed')))}; kill -KILL "$PPID";; esac`);
  const killed = setup.install(); assert.notEqual(killed.status, 0); assert.ok(existsSync(marker), killed.stderr);
  passed(setup.install());
  assert.equal(pointers(setup), '0.1.0\n0.1.0-rc.1\n');
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
