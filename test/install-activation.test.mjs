import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { installation, archive } from './installer-fixture.mjs';

for (const prior of [false, true]) test(`failed activation restores ${prior ? 'the previous pack' : 'no active pack'}`, { skip: process.platform === 'win32' }, t => {
  const f = installation(t, { tools: ['studio'] });
  if (prior) {
    const result = f.install(); assert.equal(result.status, 0, result.stderr);
    f.pack.version = '0.2.0';
  }
  const file = join(f.root, 'fake node/bin/node');
  writeFileSync(file, readFileSync(file, 'utf8').replace("echo 'fixture doctor: ok'; exit 0", "echo 'activation doctor failed' >&2; exit 9"));
  f.pack.runtimes.node.archives['darwin-arm64'] = archive(join(f.root, 'fake node'), join(f.root, 'broken node.tar.gz'));
  f.save();
  const result = f.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Activation failed; rolled back/);
  if (prior) assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
  else {
    assert.equal(existsSync(join(f.toolkit, 'active')), false);
    assert.equal(existsSync(join(f.home, '.praxity/bin/praxity')), false);
  }
});
