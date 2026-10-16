import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, repository } from './helpers.mjs';
import { posix, quote, shell } from './installer-fixture.mjs';

test('trial downloads Rubato and reaches its installer in the extracted archive', t => {
  const { root, home } = fixture(t);
  const payload = join(root, 'download'), archive = join(root, 'rubato.tar.gz');
  mkdirSync(join(payload, 'rubato-main'), { recursive: true });
  // Stop before installing anything or launching Studio.
  writeFileSync(join(payload, 'rubato-main/install.sh'), 'echo "Trial installer reached"; exit 1\n');
  const packed = shell(`tar -czf ${quote(posix(archive))} -C ${quote(posix(payload))} rubato-main`);
  assert.equal(packed.status, 0, packed.stderr);
  const result = shell(`
    export HOME=${quote(posix(home))}
    curl() {
      [ "$1" = -fsSL ] && [ "$2" = https://github.com/Praxity/rubato/archive/refs/heads/main.tar.gz ] || return 99
      cat ${quote(posix(archive))}
    }
    . ${quote(posix(join(repository, 'try.sh')))}
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Trial installer reached/);
  assert.ok(existsSync(join(home, 'rubato-main/install.sh')));
  assert.equal(existsSync(join(home, '.praxity')), false);
});
