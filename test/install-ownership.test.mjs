import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installation } from './installer-fixture.mjs';

for (const name of ['.cache/user.txt', '.bootstrap-other/user.txt']) test(`installer refuses unrecorded scratch content ${name} even on rerun`, t => {
  const setup = installation(t);
  const first = setup.install(); assert.equal(first.status, 0, first.stderr);
  const file = join(setup.toolkit, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'USER FILE');
  const before = readFileSync(join(setup.toolkit, 'active'), 'utf8');
  const second = setup.install(); assert.notEqual(second.status, 0); assert.match(second.stderr, /unowned/i);
  assert.equal(readFileSync(file, 'utf8'), 'USER FILE');
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8'), before);
});
