import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { shell, posix, quote } from './installer-fixture.mjs';
import { repository } from './helpers.mjs';

function nonportable(source) {
  const code = source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  return [
    /\breadlink\s+(?:-f|--canonicalize)(?:\s|$)/,
    /\bstat\s+(?:-c|--format)(?:\s|=|$)/,
    /\bsed\s+-i(?:\s+(?!''(?:\s|$)|""(?:\s|$)|['"]?\.[\w.-]+['"]?(?:\s|$))|$)/,
    /\btar\s+[^\n]*(?:--warning|--transform|--sort|--show-transformed-names)(?:\s|=|$)/,
    /\bmktemp\s+--tmpdir(?:\s|=|$)/,
    /\b(?:mapfile|readarray|declare\s+-A)\b/,
  ].filter(pattern => pattern.test(code));
}
test('portability gate catches known GNU-only flags and Bash 4 constructs', () => {
  for (const source of ['readlink -f file', 'stat -c %s file', "sed -i 's/a/b/' file", 'tar --warning=no-unknown-keyword -xf file', 'mktemp --tmpdir', 'declare -A map', 'mapfile rows']) assert.ok(nonportable(source).length, source);
  for (const source of ["sed -i '' 's/a/b/' file", "sed -i .bak 's/a/b/' file", "sed -i.bak 's/a/b/' file", 'shasum -a 256 file', 'tar -P -tvf file', 'tar -xf file --strip-components=1']) assert.equal(nonportable(source).length, 0, source);
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
