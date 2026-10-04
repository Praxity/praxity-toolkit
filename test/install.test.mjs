import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fixture, repository, examplePack } from './helpers.mjs';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const posix = path => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, letter) => `/${letter.toLowerCase()}`) : path;
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
function shell(command, options = {}) {
  return spawnSync(bash, ['-c', command], { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024, ...options });
}
function archive(directory, output) {
  const result = shell(`tar -czf ${quote(posix(output))} -C ${quote(posix(directory))} .`);
  assert.equal(result.status, 0, result.stderr);
  return { status: 'published', url: pathToFileURL(output).href,
    sha256: createHash('sha256').update(readFileSync(output)).digest('hex'), format: 'tar.gz', stripComponents: 0 };
}
function installation(t, options = {}) {
  const { root, home: originalHome } = fixture(t);
  const home = options.homeName ? join(root, options.homeName) : originalHome;
  if (options.homeName) mkdirSync(home);
  const pack = examplePack();
  const runtime = join(root, 'fake node');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  const binary = process.execPath.replaceAll('\\', '/');
  // MSYS does not reliably convert paths containing apostrophes for native
  // Node. The fixture emulates a POSIX Node by converting its filesystem args.
  const nativeArguments = process.platform === 'win32' ? 'for fixture_arg do\n  shift\n  case "$fixture_arg" in /*) fixture_arg=$(cygpath -m "$fixture_arg");; esac\n  set -- "$@" "$fixture_arg"\ndone\n' : '';
  // The fake archive delegates parsing/finalization to the test's real Node.
  // Its doctor output is a fake external CLI, independent of doctor unit tests.
  writeFileSync(join(runtime, 'bin/node'), `#!/bin/sh\nif [ "${'$'}{1:-}" = --version ]; then echo v24.21.0; exit 0; fi\ncase "${'$'}{1:-}" in */src/cli.mjs) if [ "${'$'}{2:-}" = doctor ]; then echo 'fixture doctor: ok'; exit 0; fi;; esac\n${nativeArguments}exec ${quote(binary)} "${'$'}@"\n`, { mode: 0o755 });
  writeFileSync(join(runtime, 'LICENSE'), 'Node fixture licence\n');
  pack.runtimes.node.archives['darwin-arm64'] = archive(runtime, join(root, 'node archive.tar.gz'));
  const typst = join(root, 'fake typst'); mkdirSync(typst);
  writeFileSync(join(typst, 'typst'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(typst, 'LICENSE'), 'Typst fixture licence\n');
  pack.runtimes.typst.archives['darwin-arm64'] = archive(typst, join(root, 'typst archive.tar.gz'));
  if (options.tool !== false) {
    const studio = join(root, 'fake studio'); mkdirSync(studio);
    writeFileSync(join(studio, 'praxity.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    writeFileSync(join(studio, 'THIRD-PARTY-NOTICES.md'), 'Tool legal fixture\n');
    mkdirSync(join(studio, 'skill'));
    writeFileSync(join(studio, 'skill/SKILL.md'), '---\nname: prax-format\ndescription: Write a course.\n---\nTool-owned skill.\n');
    pack.tools[0].archives['darwin-arm64'] = archive(studio, join(root, 'studio archive.tar.gz'));
  }
  const manifest = join(root, 'manifest file.json');
  const save = () => writeFileSync(manifest, JSON.stringify(pack, null, 2));
  save();
  const env = { ...process.env, HOME: posix(home), USERPROFILE: home, MSYS_NO_PATHCONV: undefined };
  const install = (extra = '') => shell(`sh ${quote(posix(join(repository, 'install.sh')))} --manifest ${quote(pathToFileURL(manifest).href)} --platform darwin-arm64 ${extra}`, { env });
  const action = command => shell(`sh ${quote(posix(join(repository, 'install.sh')))} ${command}`, { env });
  return { root, home, pack, manifest, save, env, install, action, toolkit: join(home, '.praxity/toolkit') };
}
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
test('dead-process lock is reclaimed; unsafe archive links are rejected before extraction', t => {
  const setup = installation(t);
  mkdirSync(join(setup.toolkit, '.install-lock'), { recursive: true });
  writeFileSync(join(setup.toolkit, '.install-lock/pid'), '99999999\n');
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
