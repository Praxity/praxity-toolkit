import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { installation, archive, posix, quote } from './installer-fixture.mjs';

test('an interrupted stage with recorded internal archive symlinks resumes safely', t => {
  const setup = installation(t), marker = join(setup.root, 'killed-before-finalize');
  const node = join(setup.root, 'fake node/bin/node');
  const script = readFileSync(node, 'utf8');
  writeFileSync(node, script.replace('#!/bin/sh\n', `#!/bin/sh\nif [ "\${2:-}" = finalize ] && [ ! -e ${quote(posix(marker))} ]; then touch ${quote(posix(marker))}; kill -KILL "$PPID"; exit 1; fi\n`), { mode: 0o755 });
  setup.pack.runtimes.node.archives['darwin-arm64'] = archive(join(setup.root, 'fake node'), join(setup.root, 'node archive.tar.gz'));
  const studio = join(setup.root, 'fake studio');
  renameSync(join(studio, 'praxity.mjs'), join(studio, 'real.mjs'));
  symlinkSync('real.mjs', join(studio, 'praxity.mjs'), 'file');
  setup.pack.tools[0].archives['darwin-arm64'] = archive(studio, join(setup.root, 'studio archive.tar.gz'));
  setup.env.MSYS = 'winsymlinks:nativestrict'; setup.save();
  const first = setup.install(); assert.notEqual(first.status, 0); assert.ok(existsSync(marker), first.stderr);
  assert.ok(lstatSync(join(setup.toolkit, '.staging-0.1.0/tools/studio/praxity.mjs')).isSymbolicLink());
  const second = setup.install(); assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8').split('\n')[0], '0.1.0');
});
