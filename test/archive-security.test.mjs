import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { installation, shell, posix, quote, archive } from './installer-fixture.mjs';
import { repository } from './helpers.mjs';
function tar(entries) {
  const parts = [];
  for (const { name, link = '', type = '0', data = '' } of entries) {
    const content = Buffer.from(data), h = Buffer.alloc(512);
    const put = (offset, length, value) => h.write(value, offset, length, 'utf8');
    put(0, 100, name); put(100, 8, '0000755\0'); put(108, 8, '0000000\0'); put(116, 8, '0000000\0');
    put(124, 12, content.length.toString(8).padStart(11, '0') + '\0'); put(136, 12, '00000000000\0');
    put(148, 8, '        '); put(156, 1, type); put(157, 100, link); put(257, 6, 'ustar\0'); put(263, 2, '00');
    put(148, 8, [...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ');
    parts.push(h, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
const variants = {
  parent: [{ name: '../outside', data: 'bad' }],
  absolute: [{ name: '/tmp/praxity-review-outside', data: 'bad' }],
  symlink: [{ name: 'escape', type: '2', link: '../../outside' }],
  hardlink: [{ name: 'escape', type: '1', link: '../../outside' }],
  linkchain: [{ name: 'one', type: '2', link: 'two' }, { name: 'two', type: '2', link: '../../outside' }, { name: 'one/file', data: 'bad' }],
};
for (const [id, entries] of Object.entries(variants)) test(`archive preflight rejects ${id} before extraction`, t => {
  const setup = installation(t);
  const file = join(setup.root, 'attack.tar.gz'), bytes = tar(entries); writeFileSync(file, bytes);
  setup.pack.tools[0].archives['darwin-arm64'] = { status: 'published', url: pathToFileURL(file).href,
    sha256: createHash('sha256').update(bytes).digest('hex'), format: 'tar.gz', stripComponents: 0 }; setup.save();
  const r = setup.install();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unsafe archive/);
  assert.doesNotMatch(r.stderr, /tar: .*Cannot hard link/);
  assert.equal(existsSync(join(setup.toolkit, 'active')), false);
  assert.equal(existsSync(join(setup.root, 'outside')), false);
});
test('BSD tar completes the local installer fixture', { skip: process.platform !== 'win32' }, t => {
  const setup = installation(t), bin = join(setup.root, 'bsd-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'tar'), '#!/bin/sh\nexec /c/Windows/System32/tar.exe "$@"\n', { mode: 0o755 });
  const r = shell(`export PATH=${quote(posix(bin))}:"$PATH"; sh ${quote(posix(join(repository, 'install.sh')))} --manifest ${quote(pathToFileURL(setup.manifest).href)} --platform darwin-arm64`, { env: setup.env });
  assert.equal(r.status, 0, r.stderr);
});

test('XZ archive hashes are journaled before extraction with BSD tar inventory', t => {
  const setup = installation(t, { tool: false }), file = join(setup.root, 'typst.tar.xz');
  if (process.platform === 'win32') {
    // Native Node receives Windows paths from the fixture adapter. Use native
    // BSD tar so GNU tar does not interpret the drive colon as a remote host.
    const node = join(setup.root, 'fake node/bin/node');
    writeFileSync(node, readFileSync(node, 'utf8').replace('\nexec ', '\nPATH=/c/Windows/System32:"$PATH" exec '));
    setup.pack.runtimes.node.archives['darwin-arm64'] = archive(join(setup.root, 'fake node'), join(setup.root, 'node archive.tar.gz'));
  }
  const packed = shell(`tar -cJf ${quote(posix(file))} -C ${quote(posix(join(setup.root, 'fake typst')))} .`);
  assert.equal(packed.status, 0, packed.stderr);
  setup.pack.runtimes.typst.archives['darwin-arm64'] = { status: 'published', url: pathToFileURL(file).href,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), format: 'tar.xz', stripComponents: 0 };
  setup.save();
  const installed = setup.install(); assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(join(setup.toolkit, '0.1.0/runtimes/typst/LICENSE'), 'utf8'), 'Typst fixture licence\n');
  const removed = setup.action('uninstall'); assert.equal(removed.status, 0, removed.stderr);
});
