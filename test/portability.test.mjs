import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { interruptInstaller, shell, posix, quote } from './installer-fixture.mjs';
import { fixture, repository } from './helpers.mjs';
import { installJournal } from '../src/install-ledger.mjs';

function nonportable(source) {
  const code = source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  return [
    /\/\[(?:\\.|[^\]\\/\n])*\/[^\]\n]*\]/,
    /\breadlink\b[^\n;]*\s(?:-f|--canonicalize)(?:\s|$)/,
    /\bstat\b[^\n;]*\s(?:-[Lf]*c|--format)(?:\s|=|$)/,
    /\bsed\b[^\n;]*\s-[Enr]*i(?:\s+(?!''(?:\s|$)|""(?:\s|$)|['"]?\.[\w.-]+['"]?(?:\s|$))|$)/,
    /\bfind\b[^\n;]*\s-printf(?:\s|=|$)/,
    /\bdate\b[^\n;]*\s(?:-d|--date)(?:\s|=|$)/,
    /\bgrep\b[^\n;]*\s-[A-Za-z]*P(?:\s|$)/,
    /\bsort\b[^\n;]*\s-[A-Za-z]*z(?:\s|$)/,
    /\bxargs\b[^\n;]*\s-[A-Za-z]*r(?:\s|$)/,
    /\btar\s+[^\n]*(?:--warning|--transform|--sort|--show-transformed-names)(?:\s|=|$)/,
    /\bmktemp\s+--tmpdir(?:\s|=|$)/,
    /\b(?:mapfile|readarray|declare\s+-A)\b/,
  ].filter(pattern => pattern.test(code));
}
test('portability gate catches known GNU-only flags and Bash 4 constructs', () => {
  for (const source of ['readlink -f file', 'stat -c %s file', 'stat -Lc %s file', 'stat -L -c %s file', "sed -i 's/a/b/' file", "sed -Ei 's/a/b/' file", "sed -E -i 's/a/b/' file", 'find . -type f -printf %p', 'date -d yesterday', 'tar --warning=no-unknown-keyword -xf file', 'mktemp --tmpdir', 'declare -A map', 'mapfile rows', 'grep -P pattern file', 'sort -z file', 'xargs -r echo']) assert.ok(nonportable(source).length, source);
  for (const source of ["sed -i '' 's/a/b/' file", "sed -i .bak 's/a/b/' file", "sed -i.bak 's/a/b/' file", "sed -Ei.bak 's/a/b/' file", "sed -E -i '' 's/a/b/' file", 'find . -type f -print', 'stat -f %z file', 'date -u', 'readlink file', 'shasum -a 256 file', 'tar -P -tvf file', 'tar -xf file --strip-components=1']) assert.equal(nonportable(source).length, 0, source);
});

test('portability gate catches unescaped slash delimiters in awk character classes', () => {
  for (const source of ['sub(/[^/]+$/, "", member)', "awk '/[a/b]/ {print}' file"]) assert.ok(nonportable(source).length, source);
  for (const source of ['sub(/[^\\/]+$/, "", member)', 'split(path, parts, "/")']) assert.equal(nonportable(source).length, 0, source);
});

test('journal accepts a home alias and still refuses descendant symlinks and outside paths', t => {
  const { root, home } = fixture(t), alias = join(root, 'home alias');
  symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const toolkit = join(alias, 'toolkit'); mkdirSync(toolkit);
  writeFileSync(join(toolkit, '.install-ledger.tsv'), 'praxity-toolkit-install-ledger-v1\n');
  const journal = () => installJournal(alias, toolkit), file = join(toolkit, 'owned');
  journal().write(file, 'expected bytes');
  journal().complete(file);
  assert.equal(readFileSync(file, 'utf8'), 'expected bytes');
  const outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'user'), 'USER FILE');
  symlinkSync(outside, join(toolkit, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => journal().write(join(toolkit, 'escape/user'), 'changed'), /containment refused/i);
  symlinkSync(toolkit, join(toolkit, 'internal'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => journal().write(join(toolkit, 'internal/owned'), 'changed'), /symlink refused/i);
  assert.equal(readFileSync(file, 'utf8'), 'expected bytes');
  assert.throws(() => journal().write(join(outside, 'user'), 'changed'), /containment refused/i);
  assert.equal(readFileSync(join(outside, 'user'), 'utf8'), 'USER FILE');
  journal().remove(file);
  assert.equal(existsSync(file), false);
});

test('fixture paths use the same canonical spelling as skill crash hooks', t => {
  const { root, home } = fixture(t), alias = join(root, 'temporary alias');
  symlinkSync(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const code = `import {fixture} from ${JSON.stringify(new URL('./helpers.mjs', import.meta.url).href)};
    import {realpathSync} from 'node:fs';
    const {root,home}=fixture({after(){}}); console.log(JSON.stringify({root,home,canonicalRoot:realpathSync(root),canonicalHome:realpathSync(home)}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias }, timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  const paths = JSON.parse(child.stdout);
  assert.equal(paths.root, paths.canonicalRoot);
  assert.equal(paths.home, paths.canonicalHome);
});

test('crash shims kill the installer through an intermediate fetch shell', t => {
  const { root, home } = fixture(t), toolkit = join(home, '.praxity/toolkit');
  const pid = join(toolkit, '.install-lock/pid'), cleanup = join(root, 'cleanup');
  mkdirSync(join(toolkit, '.install-lock'), { recursive: true });
  const grandchild = `sh -c ${quote(interruptInstaller({ toolkit }))}; :`;
  const installer = `trap ${quote(`touch ${quote(posix(cleanup))}`)} EXIT
    printf '%s\\n' "$$" > ${quote(posix(pid))}
    sh -c ${quote(grandchild)}
    :`;
  const killed = shell(`sh -c ${quote(installer)}`);
  assert.notEqual(killed.status, 0, killed.stderr);
  assert.equal(existsSync(cleanup), false, 'Installer survived the crash and ran cleanup');
  assert.ok(existsSync(pid));
});
test('installer scripts use BSD-compatible commands and pass sh/bash syntax checks', () => {
  const files = ['install.sh', ...readdirSync(join(repository, 'scripts')).filter(name => /\.(sh|awk)$/.test(name)).map(name => `scripts/${name}`)];
  for (const file of files) {
    const path = join(repository, file);
    assert.deepEqual(nonportable(readFileSync(path, 'utf8')), [], file);
    for (const interpreter of file.endsWith('.awk') ? [] : ['sh', 'bash']) {
      const result = shell(`${interpreter} -n ${quote(posix(path))}`);
      assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    }
  }
});
