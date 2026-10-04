import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { shell, posix, quote } from './installer-fixture.mjs';
import { repository } from './helpers.mjs';

function nonportable(source) {
  const code = source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  return [
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
test('installer scripts use BSD-compatible commands and pass sh/bash syntax checks', () => {
  const files = ['install.sh', ...readdirSync(join(repository, 'scripts')).filter(name => name.endsWith('.sh')).map(name => `scripts/${name}`)];
  for (const file of files) {
    const path = join(repository, file);
    assert.deepEqual(nonportable(readFileSync(path, 'utf8')), [], file);
    for (const interpreter of ['sh', 'bash']) {
      const result = shell(`${interpreter} -n ${quote(posix(path))}`);
      assert.equal(result.status, 0, `${file}: ${result.stderr}`);
    }
  }
});
