import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, repository } from './helpers.mjs';

test('finalize rejects a symlink above the stage before reading or generating its contents', t => {
  const { context } = fixture(t);
  const outside = join(context.root, 'outside'); mkdirSync(join(outside, 'stage'), { recursive: true });
  const base = join(context.root, 'toolkit'); mkdirSync(base);
  symlinkSync(outside, join(base, 'ancestor'), process.platform === 'win32' ? 'junction' : 'dir');
  const manifest = join(context.root, 'pack.json'); writeFileSync(manifest, JSON.stringify(context.pack));
  const r = spawnSync(process.execPath, [join(repository, 'src/install.mjs'), 'finalize', manifest, 'darwin-arm64', join(base, 'ancestor/stage'), base], { encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /symlink|containment/i);
  assert.equal(existsSync(join(outside, 'stage/state.json')), false);
});
