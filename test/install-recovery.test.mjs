import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, symlinkSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installation, archive, posix, shell, quote, crashAfter } from './installer-fixture.mjs';

for (const update of [false, true]) for (const boundary of ['extraction', 'version rename']) test(`rerun recovers ${update ? 'update' : 'first install'} killed after ${boundary}`, t => {
  const setup = installation(t, { tool: false });
  if (update) {
    const first = setup.install(); assert.equal(first.status, 0, first.stderr);
    setup.pack.version = '0.2.0'; setup.save();
  }
  const markerPath = quote(posix(join(setup.root, 'crashed')));
  const condition = boundary === 'extraction'
    ? `case "$1:$*" in -xf:*) touch ${markerPath}; kill -KILL "$PPID";; esac`
    : `case "$1" in */.staging-*) touch ${markerPath}; kill -KILL "$PPID";; esac`;
  const marker = crashAfter(setup, boundary === 'extraction' ? 'tar' : 'mv', condition);
  const killed = setup.install(); assert.notEqual(killed.status, 0); assert.ok(existsSync(marker), killed.stderr);
  const retry = setup.install(); assert.equal(retry.status, 0, retry.stderr);
  const pointers = readFileSync(join(setup.toolkit, 'active'), 'utf8').split('\n');
  assert.equal(pointers[0], update ? '0.2.0' : '0.1.0');
  if (update) assert.equal(pointers[1], '0.1.0');
  const version = shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} version`, { env: setup.env });
  assert.equal(version.status, 0, version.stderr); assert.equal(JSON.parse(version.stdout).pack, pointers[0]);
  const removed = setup.action('uninstall'); assert.equal(removed.status, 0, removed.stderr);
});

test('recovery after extraction preserves an additional unrecorded file', t => {
  const setup = installation(t, { tool: false });
  crashAfter(setup, 'tar', `case "$1" in -xf) touch ${quote(posix(join(setup.root, 'crashed')))}; kill -KILL "$PPID";; esac`);
  assert.notEqual(setup.install().status, 0);
  const file = join(setup.toolkit, '.bootstrap-0.1.0/user.txt'); writeFileSync(file, 'USER FILE');
  assert.notEqual(setup.install().status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'USER FILE');
});

for (const damagedPath of ['runtimes/typst/LICENSE', 'runtimes/node/bin/node']) test(`rollback keeps a damaged outgoing ${damagedPath} and activates an intact destination`, t => {
  const setup = installation(t, { tool: false });
  assert.equal(setup.install().status, 0);
  setup.pack.version = '0.2.0'; setup.save();
  assert.equal(setup.install().status, 0);
  const damaged = join(setup.toolkit, '0.2.0', damagedPath);
  writeFileSync(damaged, 'damaged notice\n');
  const rollback = setup.action('rollback'); assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stderr, /damaged.*(?:kept|preserv)|(?:kept|preserv).*damaged/i);
  assert.equal(readFileSync(damaged, 'utf8'), 'damaged notice\n');
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8'), '0.1.0\n0.2.0\n');
  const version = shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} version`, { env: setup.env });
  assert.equal(version.status, 0, version.stderr); assert.equal(JSON.parse(version.stdout).pack, '0.1.0');
});

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

test('rerun recovers a recorded archive symlink whose target was not extracted yet', t => {
  const setup = installation(t), studio = join(setup.root, 'fake studio');
  renameSync(join(studio, 'praxity.mjs'), join(studio, 'real.mjs'));
  symlinkSync('real.mjs', join(studio, 'praxity.mjs'), 'file');
  setup.pack.tools[0].archives['darwin-arm64'] = archive(studio, join(setup.root, 'studio archive.tar.gz'));
  setup.env.MSYS = 'winsymlinks:nativestrict'; setup.save();
  const bin = join(setup.root, 'partial-bin'), marker = join(setup.root, 'partial-cut'); mkdirSync(bin);
  const real = shell('command -v tar').stdout.trim();
  writeFileSync(join(bin, 'tar'), `#!/bin/sh\narchive=\ndirectory=\nnext=\nfor arg do\n  if [ "$next" = directory ]; then directory=$arg; next=; fi\n  if [ "$arg" = -C ]; then next=directory; fi\ndone\nif [ "$1" = -xf ] && [ ! -e ${quote(posix(marker))} ]; then\n  case "$directory" in */tools/studio) ${quote(real)} -xf "$2" -C "$directory" ./praxity.mjs || exit $?; touch ${quote(posix(marker))}; kill -KILL "$PPID"; exit 77;; esac\nfi\nexec ${quote(real)} "$@"\n`, { mode: 0o755 });
  const init = join(setup.root, 'partial-env');
  writeFileSync(init, (setup.env.BASH_ENV ? readFileSync(setup.env.BASH_ENV.replace(/^\/([a-z])\//, '$1:/'), 'utf8') : '') + `\nexport PATH=${quote(posix(bin))}:"$PATH"\n`);
  setup.env.BASH_ENV = posix(init);
  const interrupted = setup.install(); assert.notEqual(interrupted.status, 0); assert.ok(existsSync(marker), interrupted.stderr);
  const link = join(setup.toolkit, '.staging-0.1.0/tools/studio/praxity.mjs');
  assert.ok(lstatSync(link).isSymbolicLink()); assert.equal(existsSync(link), false);
  const retry = setup.install(); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8').split('\n')[0], '0.1.0');
  const removed = setup.action('uninstall'); assert.equal(removed.status, 0, removed.stderr);
});
