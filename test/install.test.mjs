import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fixture, repository, examplePack } from './helpers.mjs';

import { installation, shell, posix, quote, archive } from './installer-fixture.mjs';

const passed = result => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
test('POSIX bootstrap fresh install and idempotent rerun, with spaces and no profile edits', t => {
  const setup = installation(t);
  writeFileSync(join(setup.home, '.profile'), 'User profile\n');
  writeFileSync(join(setup.home, 'AGENTS.md'), 'User instructions\n');
  passed(setup.install());
  const current = join(setup.toolkit, '0.1.0');
  assert.ok(existsSync(join(current, 'state.json')));
  assert.ok(existsSync(join(current, 'tools/studio/praxity.mjs')));
  assert.equal(existsSync(join(current, 'tools/check')), false);
  const before = readFileSync(join(current, 'state.json'), 'utf8');
  passed(setup.install());
  assert.equal(readFileSync(join(current, 'state.json'), 'utf8'), before);
  const version = shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} version`, { env: setup.env });
  passed(version); assert.equal(JSON.parse(version.stdout).pack, '0.1.0');
  assert.equal(readFileSync(join(setup.home, '.profile'), 'utf8'), 'User profile\n');
  assert.equal(readFileSync(join(setup.home, 'AGENTS.md'), 'utf8'), 'User instructions\n');
  assert.equal(existsSync(join(setup.toolkit, '.install-lock')), false);
});
test('checksum mismatch refuses publication and launchers', t => {
  const setup = installation(t);
  setup.pack.tools[0].archives['darwin-arm64'].sha256 = 'a'.repeat(64); setup.save();
  const result = setup.install();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Checksum mismatch/);
  assert.equal(existsSync(join(setup.toolkit, 'active')), false);
  assert.equal(existsSync(join(setup.toolkit, '0.1.0')), false);
  assert.equal(existsSync(join(setup.home, '.praxity/bin/praxity')), false);
});
test('interrupted install resumes from verified downloads', t => {
  const setup = installation(t);
  const mock = join(setup.root, 'mock bin'); mkdirSync(mock);
  const marker = join(setup.root, 'interrupted');
  const curl = shell('command -v curl'); passed(curl);
  writeFileSync(join(mock, 'curl'), `#!/bin/sh\ncase "${'$'}*" in *typst%20archive*) if [ ! -e ${quote(posix(marker))} ]; then touch ${quote(posix(marker))}; kill -TERM "${'$'}PPID"; exit 1; fi;; esac\nexec ${quote(curl.stdout.trim())} "${'$'}@"\n`, { mode: 0o755 });
  const original = setup.env.PATH;
  // A POSIX PATH is set inside bash, avoiding Windows PATH conversion rules.
  const result = shell(`export PATH=${quote(posix(mock))}:"${'$'}PATH"; sh ${quote(posix(join(repository, 'install.sh')))} --manifest ${quote(pathToFileURL(setup.manifest).href)} --platform darwin-arm64`, { env: setup.env });
  assert.notEqual(result.status, 0); assert.ok(existsSync(marker), result.stderr);
  assert.equal(existsSync(join(setup.toolkit, 'active')), false);
  const cache = readdirSync(join(setup.toolkit, '.cache')).filter(name => !name.endsWith('.part'));
  assert.ok(cache.includes(`${setup.pack.runtimes.node.archives['darwin-arm64'].sha256}.tar.gz`));
  setup.env.PATH = original;
  passed(setup.install());
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8').split('\n')[0], '0.1.0');
});
test('update keeps previous version, rollback works through launcher, uninstall preserves unrelated data', t => {
  const setup = installation(t); passed(setup.install());
  setup.pack.version = '0.2.0'; setup.save(); passed(setup.install());
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8').split('\n')[1], '0.1.0');
  const rolled = shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} rollback`, { env: setup.env });
  passed(rolled);
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8').split('\n')[0], '0.1.0');
  assert.ok(existsSync(join(setup.toolkit, '0.2.0/state.json')));
  mkdirSync(join(setup.home, '.praxity/check'), { recursive: true });
  writeFileSync(join(setup.home, '.praxity/check/user-component'), 'Keep me');
  passed(setup.action('uninstall')); passed(setup.action('uninstall'));
  assert.equal(existsSync(join(setup.home, '.praxity/bin/praxity')), false);
  assert.equal(existsSync(join(setup.toolkit, '0.1.0')), false);
  assert.equal(readFileSync(join(setup.home, '.praxity/check/user-component'), 'utf8'), 'Keep me');
});
test('changed manifest and damaged installed files cannot silently replace a version', t => {
  const setup = installation(t); passed(setup.install());
  setup.pack.tools[1].version = '0.6.1'; setup.save();
  const changed = setup.install(); assert.notEqual(changed.status, 0); assert.match(changed.stderr, /different manifest/);
  setup.pack.tools[1].version = '0.6.0'; setup.save();
  writeFileSync(join(setup.toolkit, '0.1.0/tools/studio/praxity.mjs'), 'Modified');
  const damaged = setup.install(); assert.notEqual(damaged.status, 0); assert.match(damaged.stderr, /Installed file damaged/);
});
test('existing live install lock blocks another process', t => {
  const setup = installation(t);
  mkdirSync(join(setup.toolkit, '.install-lock'), { recursive: true });
  const result = shell(`echo ${'$'}${'$'} > ${quote(posix(join(setup.toolkit, '.install-lock/pid')))}; sh ${quote(posix(join(repository, 'install.sh')))} --manifest ${quote(pathToFileURL(setup.manifest).href)} --platform darwin-arm64`, { env: setup.env });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Install locked by process/);
  assert.equal(existsSync(join(setup.toolkit, 'active')), false);
});
test('unowned launcher and pack directories survive refusal', t => {
  const setup = installation(t);
  mkdirSync(join(setup.home, '.praxity/bin'), { recursive: true });
  writeFileSync(join(setup.home, '.praxity/bin/praxity'), 'My launcher');
  const result = setup.install(); assert.notEqual(result.status, 0); assert.match(result.stderr, /unowned/);
  assert.equal(readFileSync(join(setup.home, '.praxity/bin/praxity'), 'utf8'), 'My launcher');
  rmSync(join(setup.home, '.praxity/bin/praxity'));
  mkdirSync(join(setup.toolkit, 'unowned')); writeFileSync(join(setup.toolkit, 'unowned/keep'), 'Keep me');
  assert.notEqual(setup.action('uninstall').status, 0);
  assert.equal(readFileSync(join(setup.toolkit, 'unowned/keep'), 'utf8'), 'Keep me');
});
test('damaged cache and unsupported platform are refused', t => {
  const setup = installation(t);
  mkdirSync(join(setup.toolkit, '.cache'), { recursive: true });
  const archive = setup.pack.runtimes.node.archives['darwin-arm64'];
  writeFileSync(join(setup.toolkit, '.cache', `${archive.sha256}.tar.gz`), 'bad cache');
  const damaged = setup.install(); assert.notEqual(damaged.status, 0); assert.match(damaged.stderr, /Cached checksum mismatch/);
  const unsupported = setup.install('--platform linux-x64');
  assert.notEqual(unsupported.status, 0); assert.match(unsupported.stderr, /not implemented/);
});
test('quoted absolute launchers tolerate apostrophes as well as spaces', t => {
  const setup = installation(t, { homeName: "designer's home" });
  passed(setup.install());
  const version = shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} version`, { env: setup.env });
  passed(version); assert.equal(JSON.parse(version.stdout).pack, '0.1.0');
});
test('owned dead-process lock is reclaimed; unsafe archive links are rejected before extraction', t => {
  const setup = installation(t);
  const mock = join(setup.root, 'kill-bin'); mkdirSync(mock);
  writeFileSync(join(mock, 'curl'), '#!/bin/sh\nkill -KILL "$PPID"\nexit 1\n', { mode: 0o755 });
  const interrupted = shell(`export PATH=${quote(posix(mock))}:"$PATH"; sh ${quote(posix(join(repository, 'install.sh')))} --manifest ${quote(pathToFileURL(setup.manifest).href)} --platform darwin-arm64`, { env: setup.env });
  assert.notEqual(interrupted.status, 0);
  assert.ok(existsSync(join(setup.toolkit, '.install-lock/pid')));
  passed(setup.install());
  const linkListing = join(setup.root, 'link listing');
  writeFileSync(linkListing, 'lrwxrwxrwx owner/group 0 2026-01-01 12:00 archive/bin/node -> /outside\n');
  const result = shell(`awk -v strip=1 -f ${quote(posix(join(repository, 'scripts/archive-links.awk')))} ${quote(posix(linkListing))}`);
  assert.notEqual(result.status, 0);
  writeFileSync(linkListing, 'lrwxrwxrwx owner/group 0 2026-01-01 12:00 archive/bin/npm -> ../lib/npm.js\n');
  passed(shell(`awk -v strip=1 -f ${quote(posix(join(repository, 'scripts/archive-links.awk')))} ${quote(posix(linkListing))}`));
});
test('rollback refuses damaged previous version and keeps both pointers', t => {
  const setup = installation(t); passed(setup.install());
  setup.pack.version = '0.2.0'; setup.save(); passed(setup.install());
  writeFileSync(join(setup.toolkit, '0.1.0/tools/studio/praxity.mjs'), 'Damaged previous version');
  const before = readFileSync(join(setup.toolkit, 'active'), 'utf8');
  const result = setup.action('rollback');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Installed file damaged/);
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8'), before);
});
test('an escaping archive link never reaches extraction or activation', t => {
  const setup = installation(t);
  const header = Buffer.alloc(512);
  const field = (offset, length, value) => header.write(value, offset, length, 'ascii');
  field(0, 100, 'escape-link'); field(100, 8, '0000777\0');
  field(108, 8, '0000000\0'); field(116, 8, '0000000\0');
  field(124, 12, '00000000000\0'); field(136, 12, '00000000000\0');
  field(148, 8, '        '); field(156, 1, '2'); field(157, 100, '../../outside');
  field(257, 6, 'ustar\0'); field(263, 2, '00');
  const checksum = [...header].reduce((total, byte) => total + byte, 0);
  field(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  const bytes = gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
  const malicious = join(setup.root, 'unsafe archive.tar.gz'); writeFileSync(malicious, bytes);
  setup.pack.tools[0].archives['darwin-arm64'] = { status: 'published', url: pathToFileURL(malicious).href,
    sha256: createHash('sha256').update(bytes).digest('hex'), format: 'tar.gz', stripComponents: 0 };
  setup.save();
  const result = setup.install();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unsafe archive link/);
  assert.equal(existsSync(join(setup.toolkit, 'active')), false);
  assert.equal(existsSync(join(setup.home, '.praxity/bin/praxity')), false);
  assert.equal(existsSync(join(setup.root, 'outside')), false);
});
test('bootstrap rejects duplicate JSON keys before downloading Node', t => {
  const setup = installation(t);
  writeFileSync(setup.manifest, '{"version":"0.1.0","version":"0.2.0"}');
  const result = setup.install();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /duplicate key/);
  assert.equal(existsSync(join(setup.toolkit, '.cache')), false);
});
test('a published tool without its notices fails before activation', t => {
  const setup = installation(t);
  const bad = join(setup.root, 'incomplete legal payload'); mkdirSync(bad);
  writeFileSync(join(bad, 'praxity.mjs'), 'console.log("fixture");');
  setup.pack.tools[0].archives['darwin-arm64'] = archive(bad, join(setup.root, 'incomplete archive.tar.gz'));
  setup.save();
  const result = setup.install();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Missing notices for studio/);
  assert.equal(existsSync(join(setup.toolkit, 'active')), false);
  assert.equal(existsSync(join(setup.toolkit, '0.1.0')), false);
});

test('resumed stage ancestor symlink refuses before deleting or extracting outside', t => {
  const setup = installation(t);
  const outside = join(setup.root, 'outside');
  mkdirSync(join(outside, 'node'), { recursive: true });
  writeFileSync(join(outside, 'node/user.txt'), 'USER FILE');
  const stage = join(setup.toolkit, '.staging-0.1.0');
  mkdirSync(stage, { recursive: true });
  symlinkSync(outside, join(stage, 'runtimes'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = setup.install();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink|containment/i);
  assert.equal(readFileSync(join(outside, 'node/user.txt'), 'utf8'), 'USER FILE');
  assert.equal(existsSync(join(outside, 'node/bin/node')), false);
});

test('finalize validates the whole stage before creating wrappers or metadata', t => {
  const setup = installation(t);
  const stage = join(setup.root, 'stage'); mkdirSync(stage);
  const outside = join(setup.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(stage, 'runtimes'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, [join(repository, 'src/install.mjs'), 'finalize', setup.manifest, 'darwin-arm64', stage, setup.toolkit], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink|containment/i);
  assert.equal(existsSync(join(stage, 'state.json')), false);
});

for (const location of ['.bootstrap-0.1.0/user.txt', '.staging-0.1.0/src/user.txt']) test(`unowned ${location} blocks reuse without deleting user bytes`, t => {
  const setup = installation(t), file = join(setup.toolkit, location);
  mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'USER FILE');
  const r = setup.install(); assert.notEqual(r.status, 0); assert.match(r.stderr, /Unowned|unowned/);
  assert.equal(readFileSync(file, 'utf8'), 'USER FILE');
});
test('uninstall preserves and reports user files added to an owned version', t => {
  const setup = installation(t); passed(setup.install());
  const file = join(setup.toolkit, '0.1.0/user.txt'); writeFileSync(file, 'USER FILE');
  const before = readFileSync(join(setup.toolkit, 'active'), 'utf8');
  const r = setup.action('uninstall'); assert.notEqual(r.status, 0); assert.match(r.stderr, /user.txt/);
  assert.equal(readFileSync(file, 'utf8'), 'USER FILE');
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8'), before);
});
test('uninstall before installation refuses unowned scratch data', t => {
  const setup = installation(t), files = ['.cache/user.txt', '.staging-user/user.txt', '.bootstrap-user/user.txt'].map(name => join(setup.toolkit, name));
  for (const file of files) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'USER FILE'); }
  const r = setup.action('uninstall'); assert.notEqual(r.status, 0); assert.match(r.stderr, /Unowned|unowned/);
  for (const file of files) assert.equal(readFileSync(file, 'utf8'), 'USER FILE');
});
test('unowned dead-PID lock cannot be reclaimed', t => {
  const setup = installation(t), file = join(setup.toolkit, '.install-lock/pid');
  mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '99999999\n');
  const r = setup.action('uninstall'); assert.notEqual(r.status, 0); assert.match(r.stderr, /Unowned|unowned/);
  assert.equal(readFileSync(file, 'utf8'), '99999999\n');
});
test('modified installed files survive uninstall', t => {
  const setup = installation(t); passed(setup.install());
  const file = join(setup.toolkit, '0.1.0/tools/studio/praxity.mjs'); writeFileSync(file, 'USER EDIT');
  const r = setup.action('uninstall'); assert.notEqual(r.status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'USER EDIT');
});

test('manifest symlink refuses before curl can overwrite an outside file', t => {
  const setup = installation(t), victim = join(setup.root, 'outside.json');
  writeFileSync(victim, 'USER FILE'); mkdirSync(setup.toolkit, { recursive: true });
  symlinkSync(victim, join(setup.toolkit, '.manifest.json'), 'file');
  const r = setup.install(); assert.notEqual(r.status, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'USER FILE');
});
test('unowned fixed activation temporary file is preserved before activation', t => {
  const setup = installation(t), file = join(setup.toolkit, 'active.tmp');
  mkdirSync(setup.toolkit, { recursive: true }); writeFileSync(file, 'USER FILE');
  const r = setup.install(); assert.notEqual(r.status, 0); assert.match(r.stderr, /Unowned|unowned/);
  assert.equal(readFileSync(file, 'utf8'), 'USER FILE');
  assert.equal(existsSync(join(setup.toolkit, 'active')), false);
});
for (const name of ['active', '.manifest.tsv', '.plan.tsv', '.archive-list', '.archive-links', '.launcher-sha256']) test(`unowned metadata ${name} is refused before replacement`, t => {
  const setup = installation(t), file = join(setup.toolkit, name);
  mkdirSync(setup.toolkit, { recursive: true }); writeFileSync(file, 'USER FILE');
  const r = setup.install(); assert.notEqual(r.status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'USER FILE');
});
test('cache partial symlink cannot overwrite its outside target', t => {
  const setup = installation(t), victim = join(setup.root, 'outside'); writeFileSync(victim, 'USER FILE');
  mkdirSync(join(setup.toolkit, '.cache'), { recursive: true });
  const hash = setup.pack.runtimes.node.archives['darwin-arm64'].sha256;
  symlinkSync(victim, join(setup.toolkit, '.cache', `${hash}.tar.gz.part`), 'file');
  const r = setup.install(); assert.notEqual(r.status, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'USER FILE');
});

function remoteFixture(t, reviewed = false) {
  const setup = installation(t); setup.pack.version = '9.9.9'; setup.save();
  const bin = join(setup.root, 'curl-mock'); mkdirSync(bin);
  const realCurl = shell('command -v curl').stdout.trim();
  const manifest = reviewed ? join(repository, 'pack.json') : setup.manifest;
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\nnext=\noutput=\nlast=\nfor arg do\n  if [ "$next" = output ]; then output=$arg; next=; fi\n  if [ "$arg" = --output ]; then next=output; fi\n  last=$arg\ndone\ncase "$last" in\n  https://fixture.invalid/manifest.json) cp ${quote(posix(manifest))} "$output";;\n  file://*) exec ${quote(realCurl)} "$@";;\n  *) echo 'network disallowed in fixture' >&2; exit 98;;\nesac\n`, { mode: 0o755 });
  const init = setup.env.BASH_ENV ?? posix(join(setup.root, 'bash-env'));
  const previous = existsSync(join(setup.root, 'bash-env')) ? readFileSync(join(setup.root, 'bash-env'), 'utf8') : '';
  writeFileSync(join(setup.root, 'bash-env'), previous + `export PATH=${quote(posix(bin))}:"$PATH"\n`);
  setup.env.BASH_ENV = init;
  return setup;
}
for (const digest of [null, 'a'.repeat(64)]) test(`remote replacement manifest with ${digest ? 'wrong' : 'no'} reviewed digest cannot select Node`, t => {
  const setup = remoteFixture(t);
  const r = setup.install(`--manifest https://fixture.invalid/manifest.json${digest ? ` --manifest-sha256 ${digest}` : ''}`);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Manifest SHA-256 mismatch|reviewed digest/);
  assert.equal(existsSync(join(setup.toolkit, '.cache')), false);
  assert.equal(existsSync(join(setup.toolkit, 'active')), false);
});
test('remote manifest with the supplied reviewed digest installs local fixture archives', t => {
  const setup = remoteFixture(t), digest = createHash('sha256').update(readFileSync(setup.manifest)).digest('hex');
  passed(setup.install(`--manifest https://fixture.invalid/manifest.json --manifest-sha256 ${digest}`));
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8').split('\n')[0], '9.9.9');
});
test('remote bytes matching the reviewed checkout manifest pass trust preflight', t => {
  const setup = remoteFixture(t, true);
  const r = setup.install('--manifest https://fixture.invalid/manifest.json');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /network disallowed in fixture/);
  assert.doesNotMatch(r.stderr, /Manifest SHA-256 mismatch/);
  assert.ok(existsSync(join(setup.toolkit, '.cache')));
});
