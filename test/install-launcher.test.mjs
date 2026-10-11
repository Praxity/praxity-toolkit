import test from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, repository } from './helpers.mjs';
import { installation, shell } from './installer-fixture.mjs';

test('installed launcher returns real version output through a relocated pack linked at ~/.praxity', t => {
  const setup = installation(t, { tool: false });
  const installed = setup.install();
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  const original = join(setup.home, '.praxity'), moved = join(setup.root, 'relocated pack');
  renameSync(original, moved);
  symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir');
  const version = shell('"$HOME/.praxity/bin/praxity" version', { env: setup.env });
  assert.equal(version.status, 0, version.stderr);
  const output = JSON.parse(version.stdout);
  assert.equal(output.pack, '0.1.0');
  assert.equal(output.runtimes.node, '24.21.0');
  assert.equal(output.tools.every(tool => tool.installed === false), true);
});

test('importing the CLI through a linked source folder does not run a command', t => {
  const { root, home } = fixture(t);
  const linked = join(root, 'linked source');
  symlinkSync(repository, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const driver = join(root, 'import.mjs');
  writeFileSync(driver, `await import(${JSON.stringify(pathToFileURL(join(linked, 'src/cli.mjs')).href)}); console.log('Imported without running the CLI');\n`);
  const result = spawnSync(process.execPath, [driver], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Imported without running the CLI\n');
  assert.equal(result.stderr, '');
});
