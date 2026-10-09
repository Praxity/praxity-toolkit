import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, watch, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { buildAdapters, installSkills, uninstallSkills } from '../src/skills.mjs';
import { runCli } from '../src/cli.mjs';
import { doctor } from '../src/doctor.mjs';
import { fixture, fakeTool, repository } from './helpers.mjs';

const outputsFor = context => buildAdapters({ source: join(context.root, 'skills'), packVersion: context.pack.version });
const readState = base => JSON.parse(readFileSync(join(base, '.praxity/toolkit-skills.json'), 'utf8'));

function legacyInstall(context, host) {
  const outputs = outputsFor(context);
  const files = host === 'claude'
    ? new Map([...outputs.claude].map(([name, bytes]) => [name.replace('.claude/skills/', '.claude/plugins/praxity/skills/'), bytes]))
    : outputs[host === 't3' ? 'claude' : host];
  if (host === 'claude') files.set('.claude/plugins/praxity/.claude-plugin/plugin.json', Buffer.from(JSON.stringify({
    name: 'praxity', version: '0.1.0', description: 'Local Praxity tools for learning designers', author: { name: 'Praxity' },
  }, null, 2) + '\n'));
  for (const [name, bytes] of files) { mkdirSync(join(context.home, name, '..'), { recursive: true }); writeFileSync(join(context.home, name), bytes); }
  mkdirSync(join(context.home, '.praxity'), { recursive: true });
  writeFileSync(join(context.home, '.praxity/toolkit-skills.json'), JSON.stringify({
    owner: 'praxity-toolkit', schemaVersion: 1, host,
    files: Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])),
  }, null, 2) + '\n');
  return files;
}

for (const host of ['t3', 'claude', 'codex']) test(`schema-1 ${host} ownership migrates to an adapter set without losing owned references`, t => {
  const { context } = fixture(t);
  const references = join(context.root, 'skills/studio-editor/references'); mkdirSync(references);
  writeFileSync(join(references, 'extra.txt'), 'PACKAGED REFERENCE');
  legacyInstall(context, host);
  const outputs = outputsFor(context);
  installSkills({ base: context.home, host: 'claude', outputs });
  const state = readState(context.home);
  assert.equal(state.schemaVersion, 2); assert.equal(state.host, undefined);
  assert.deepEqual(state.hosts, host === 'codex' ? ['claude', 'codex'] : ['claude']);
  assert.equal(readFileSync(join(context.home, '.claude/skills/studio-editor/references/extra.txt'), 'utf8'), 'PACKAGED REFERENCE');
  for (const name of Object.keys(state.files)) assert.equal(createHash('sha256').update(readFileSync(join(context.home, name))).digest('hex'), state.files[name]);
  assert.equal(existsSync(join(context.home, '.claude/plugins/praxity/.claude-plugin/plugin.json')), false);
  assert.equal(existsSync(join(context.home, '.claude/plugins/praxity/skills/studio-editor/SKILL.md')), false);
});

for (const obstacle of ['modified', 'unowned']) test(`legacy plugin migration preserves ${obstacle} files and its ledger`, t => {
  const { context } = fixture(t); legacyInstall(context, 'claude');
  const path = join(context.home, '.claude/plugins/praxity', obstacle === 'modified' ? 'skills/studio-editor/SKILL.md' : 'personal.txt');
  writeFileSync(path, 'PERSONAL CONTENT');
  const before = readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8');
  assert.throws(() => installSkills({ base: context.home, host: 'codex', outputs: outputsFor(context) }), /changed|Unowned/);
  assert.equal(readFileSync(path, 'utf8'), 'PERSONAL CONTENT');
  assert.equal(readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8'), before);
  assert.equal(existsSync(join(context.home, '.agents/skills/studio-editor/SKILL.md')), false);
});

test('different hosts may use different scopes and removal cannot erase the other scope', t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  installSkills({ base: context.home, otherBase: context.cwd, host: 'claude', outputs });
  installSkills({ base: context.cwd, otherBase: context.home, host: 'codex', outputs });
  uninstallSkills({ base: context.cwd, otherBase: context.home, host: 'codex', outputs });
  assert.deepEqual(readState(context.cwd).hosts, []);
  assert.deepEqual(readState(context.home).hosts, ['claude']);
  assert.ok(existsSync(join(context.home, '.claude/skills/studio-editor/SKILL.md')));
});

test('uninstall through the CLI removes the aliased adapter and keeps other owned and unowned files', async t => {
  const { context } = fixture(t);
  for (const host of ['t3', 'codex']) await runCli(['skills', 'install', '--host', host, '--scope', 'project'], context, { print: () => {} });
  const personal = join(context.cwd, '.claude/skills/personal/SKILL.md'); mkdirSync(join(personal, '..'), { recursive: true }); writeFileSync(personal, 'PERSONAL');
  await runCli(['skills', 'uninstall', '--host', 't3', '--scope', 'project'], context, { print: () => {} });
  assert.deepEqual(readState(context.cwd).hosts, ['codex']);
  assert.ok(existsSync(join(context.cwd, '.agents/skills/studio-editor/SKILL.md')));
  assert.equal(existsSync(join(context.cwd, '.claude/skills/studio-editor/SKILL.md')), false);
  assert.equal(readFileSync(personal, 'utf8'), 'PERSONAL');
  await runCli(['skills', 'uninstall', '--host', 'codex', '--scope', 'project'], context, { print: () => {} });
  assert.deepEqual(readState(context.cwd).files, {});
  await runCli(['skills', 'uninstall', '--host', 'codex', '--scope', 'project'], context, { print: () => {} });
  assert.equal(readFileSync(personal, 'utf8'), 'PERSONAL');
});

test('selective uninstall retains the exact installed content when the canonical source has changed', t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  for (const host of ['claude', 'codex']) installSkills({ base: context.home, host, outputs });
  const before = readFileSync(join(context.home, '.claude/skills/studio-editor/SKILL.md'));
  writeFileSync(join(context.root, 'skills/studio-editor/SKILL.md'), '---\nname: studio-editor\ndescription: Changed packaged skill.\n---\nNEW VERSION\n');
  uninstallSkills({ base: context.home, host: 'codex', outputs: outputsFor(context) });
  assert.deepEqual(readFileSync(join(context.home, '.claude/skills/studio-editor/SKILL.md')), before);
  assert.deepEqual(readState(context.home).hosts, ['claude']);
  assert.equal(existsSync(join(context.home, '.agents/skills/studio-editor/SKILL.md')), false);
});

test('uninstall tolerates owned files the user deleted, in the removed and the kept adapter', t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  for (const host of ['claude', 'codex']) installSkills({ base: context.home, host, outputs });
  unlinkSync(join(context.home, '.claude/skills/studio-editor/SKILL.md'));
  unlinkSync(join(context.home, '.agents/skills/studio-editor/SKILL.md'));
  uninstallSkills({ base: context.home, host: 'claude', outputs });
  assert.deepEqual(readState(context.home).hosts, ['codex']);
  assert.equal(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')), false);
  assert.ok(existsSync(join(context.home, '.agents/skills/install-praxity/SKILL.md')));
  assert.equal(Object.hasOwn(readState(context.home).files, '.agents/skills/studio-editor/SKILL.md'), false);
  uninstallSkills({ base: context.home, host: 'codex', outputs });
  assert.deepEqual(readState(context.home).files, {});
});

for (const obstacle of ['modified', 'unowned']) test(`uninstall refuses ${obstacle} content inside an owned skill before removing files`, t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  installSkills({ base: context.home, host: 'claude', outputs });
  const path = join(context.home, '.claude/skills/studio-editor', obstacle === 'modified' ? 'SKILL.md' : 'personal.txt');
  writeFileSync(path, 'PERSONAL CONTENT');
  const before = readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8');
  assert.throws(() => uninstallSkills({ base: context.home, host: 'claude', outputs }), /changed|Unowned/);
  assert.equal(readFileSync(path, 'utf8'), 'PERSONAL CONTENT');
  assert.equal(readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8'), before);
  assert.ok(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')));
});

for (const hosts of [['claude', 'claude'], ['t3'], ['unknown'], []]) test(`invalid adapter set ${JSON.stringify(hosts)} preserves all owned files`, t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  installSkills({ base: context.home, host: 'claude', outputs });
  const state = readState(context.home);
  writeFileSync(join(context.home, '.praxity/toolkit-skills.json'), JSON.stringify({ ...state, hosts }));
  assert.throws(() => uninstallSkills({ base: context.home, host: 'claude', outputs }), /adapter|adapters/);
  assert.ok(existsSync(join(context.home, '.claude/skills/studio-editor/SKILL.md')));
});

test('Codex refuses a same-name legacy .codex skill while preserving its bytes', t => {
  const { context } = fixture(t);
  const path = join(context.home, '.codex/skills/studio-editor/SKILL.md'); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'PERSONAL');
  assert.throws(() => installSkills({ base: context.home, host: 'codex', outputs: outputsFor(context) }), /Unowned competing/);
  assert.equal(readFileSync(path, 'utf8'), 'PERSONAL');
  assert.equal(existsSync(join(context.home, '.agents/skills/studio-editor/SKILL.md')), false);
});

test('Codex installation and removal leave an unrelated symlinked Claude home alone', t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  const personal = join(context.root, 'personal-claude'); mkdirSync(personal); writeFileSync(join(personal, 'notes.txt'), 'PERSONAL');
  symlinkSync(personal, join(context.home, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  installSkills({ base: context.home, host: 'codex', outputs });
  uninstallSkills({ base: context.home, host: 'codex', outputs });
  assert.equal(readFileSync(join(personal, 'notes.txt'), 'utf8'), 'PERSONAL');
  assert.deepEqual(readState(context.home).files, {});
});

for (const operation of ['migration', 'uninstall']) for (const phase of ['stage', 'remove']) test(`${operation} recovers a crash at the ${phase} journal commit`, t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  if (operation === 'migration') legacyInstall(context, 'claude');
  else for (const host of ['claude', 'codex']) installSkills({ base: context.home, host, outputs });
  const ledger = join(context.home, '.praxity/toolkit-skills.json'), preload = join(context.root, 'commit-crash.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync; fs.renameSync=function(source,dest,...args){const result=original(source,dest,...args); if(String(dest)===${JSON.stringify(ledger)} && JSON.parse(fs.readFileSync(dest)).transaction?.phase===${JSON.stringify(phase)}) process.exit(77); return result;}; syncBuiltinESMExports();`);
  const method = operation === 'migration' ? 'installSkills' : 'uninstallSkills';
  const code = `import {buildAdapters,${method}} from ${JSON.stringify(pathToFileURL(join(repository, 'src/skills.mjs')).href)};
    ${method}({base:${JSON.stringify(context.home)},host:'claude',outputs:buildAdapters({source:${JSON.stringify(join(context.root, 'skills'))},packVersion:'0.1.0'})});`;
  const killed = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(killed.status, 77, killed.stderr);
  const interrupted = readState(context.home); assert.equal(interrupted.transaction.phase, phase);
  (operation === 'migration' ? installSkills : uninstallSkills)({ base: context.home, host: 'claude', outputs });
  const state = readState(context.home);
  assert.deepEqual(state.hosts, operation === 'migration' ? ['claude'] : ['codex']);
  assert.equal(state.transaction, undefined); assert.equal(state.lock, undefined);
  assert.equal(existsSync(join(context.home, '.praxity/toolkit-skills.lock')), false);
  assert.equal(existsSync(join(context.home, '.claude/skills/studio-editor/SKILL.md')), operation === 'migration');
  assert.equal(existsSync(join(context.home, '.claude/plugins/praxity/skills/studio-editor/SKILL.md')), false);
  if (operation === 'uninstall') assert.ok(existsSync(join(context.home, '.agents/skills/studio-editor/SKILL.md')));
});

for (const operation of ['migration', 'uninstall']) for (const modified of [false, true]) test(`${operation} ${modified ? 'preserves changed survivors' : 'recovers'} after its first owned deletion`, t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  if (operation === 'migration') legacyInstall(context, 'claude');
  else for (const host of ['claude', 'codex']) installSkills({ base: context.home, host, outputs });
  const preload = join(context.root, 'delete-crash.mjs');
  const removedRoot = join(context.home, operation === 'migration' ? '.claude/plugins/praxity/skills' : '.claude/skills');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.unlinkSync; fs.unlinkSync=function(path,...args){const result=original(path,...args); if(String(path).startsWith(${JSON.stringify(removedRoot)})) process.exit(77); return result;}; syncBuiltinESMExports();`);
  const method = operation === 'migration' ? 'installSkills' : 'uninstallSkills';
  const code = `import {buildAdapters,${method}} from ${JSON.stringify(pathToFileURL(join(repository, 'src/skills.mjs')).href)};
    ${method}({base:${JSON.stringify(context.home)},host:'claude',outputs:buildAdapters({source:${JSON.stringify(join(context.root, 'skills'))},packVersion:'0.1.0'})});`;
  const killed = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(killed.status, 77, killed.stderr);
  assert.equal(readState(context.home).transaction.phase, 'remove');
  assert.equal(existsSync(join(removedRoot, 'install-praxity/SKILL.md')), false);
  const survivor = join(removedRoot, 'studio-editor/SKILL.md');
  if (modified) {
    writeFileSync(survivor, 'PERSONAL');
    assert.throws(() => (operation === 'migration' ? installSkills : uninstallSkills)({ base: context.home, host: 'claude', outputs }), /Owned adapter changed/);
    assert.equal(readFileSync(survivor, 'utf8'), 'PERSONAL');
    assert.equal(readState(context.home).transaction.phase, 'remove');
  } else {
    (operation === 'migration' ? installSkills : uninstallSkills)({ base: context.home, host: 'claude', outputs });
    assert.deepEqual(readState(context.home).hosts, operation === 'migration' ? ['claude'] : ['codex']);
    assert.equal(existsSync(survivor), false);
    assert.equal(readState(context.home).transaction, undefined);
  }
});

for (const host of ['t3', 'claude', 'codex']) test(`an interrupted schema-1 ${host} transaction recovers before adding the new adapter`, t => {
  const { context } = fixture(t);
  const files = legacyInstall(context, host), next = readState(context.home);
  // A durable old-format stage intent, before its first staged write.
  for (const name of files.keys()) unlinkSync(join(context.home, name));
  const lock = { pid: 2147483647, token: '11111111-1111-1111-1111-111111111111' };
  writeFileSync(join(context.home, '.praxity/toolkit-skills.json'), JSON.stringify({
    owner: 'praxity-toolkit', files: {}, transaction: {
      phase: 'stage', previous: {}, next, lock,
      staged: [...files.keys()].map(name => ({ name, temp: `${name}.praxity-11111111-1111-1111-1111-111111111111.tmp` })),
    },
  }));
  installSkills({ base: context.home, host: 'codex', outputs: outputsFor(context) });
  const state = readState(context.home);
  assert.deepEqual(state.hosts, host === 'codex' ? ['codex'] : ['claude', 'codex']);
  assert.equal(state.transaction, undefined);
  assert.ok(existsSync(join(context.home, '.agents/skills/studio-editor/SKILL.md')));
  assert.equal(existsSync(join(context.home, '.claude/plugins/praxity/.claude-plugin/plugin.json')), false);
});

for (const modified of [false, true]) test(`a journaled skill temporary ${modified ? 'preserves changed bytes' : 'resumes a partial write'} without losing the previous adapter`, t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  installSkills({ base: context.home, host: 't3', outputs });
  const preload = join(context.root, 'partial-write.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.writeFileSync; fs.writeFileSync=function(path,bytes,...args){if(String(path).includes('.praxity-') && String(path).endsWith('.tmp')) {original(path,Buffer.from(bytes).subarray(0,8),...args);process.exit(77);} return original(path,bytes,...args);}; syncBuiltinESMExports();`);
  const code = `import {buildAdapters,installSkills} from ${JSON.stringify(pathToFileURL(join(repository, 'src/skills.mjs')).href)};
    installSkills({base:${JSON.stringify(context.home)},host:'codex',outputs:buildAdapters({source:${JSON.stringify(join(context.root, 'skills'))},packVersion:'0.1.0'})});`;
  const killed = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(killed.status, 77, killed.stderr);
  assert.ok(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')));
  if (modified) {
    const directory = join(context.home, '.agents/skills/install-praxity');
    const temp = join(directory, readdirSync(directory).find(name => name.endsWith('.tmp')));
    writeFileSync(temp, 'PERSONAL NOTES');
    assert.throws(() => installSkills({ base: context.home, host: 'codex', outputs }), /Owned adapter changed/);
    assert.equal(readFileSync(temp, 'utf8'), 'PERSONAL NOTES');
    assert.ok(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')));
    return;
  }
  installSkills({ base: context.home, host: 'codex', outputs });
  assert.equal(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')), true);
  assert.equal(readFileSync(join(context.home, '.agents/skills/install-praxity/SKILL.md'), 'utf8'), outputs.codex.get('.agents/skills/install-praxity/SKILL.md').toString());
  assert.equal(JSON.parse(readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8')).transaction, undefined);
});

for (const boundary of ['directory', 'pid', 'reacquired pid']) test(`skills addition recovers a crash after its ${boundary} lock write`, t => {
  const { context } = fixture(t), outputs = outputsFor(context);
  installSkills({ base: context.home, host: 't3', outputs });
  const ledger = join(context.home, '.praxity/toolkit-skills.json');
  const child = join(context.root, 'switch.mjs'), preload = join(context.root, 'cut.mjs');
  writeFileSync(child, `import {buildAdapters,installSkills} from ${JSON.stringify(pathToFileURL(join(repository, 'src/skills.mjs')).href)}; installSkills({base:${JSON.stringify(context.home)},host:'codex',outputs:buildAdapters({source:${JSON.stringify(join(context.root, 'skills'))},packVersion:'0.1.0'})});`);
  const run = () => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, child], { encoding: 'utf8', timeout: 20_000 });
  if (boundary === 'reacquired pid') {
    writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const original=fs.renameSync; fs.renameSync=function(source,dest,...args){const result=original(source,dest,...args); if(String(dest)===${JSON.stringify(ledger)} && JSON.parse(fs.readFileSync(dest)).transaction?.phase==='stage') process.exit(77); return result;}; syncBuiltinESMExports();`);
    const interrupted = run(); assert.equal(interrupted.status, 77, interrupted.stderr);
  }
  const method = boundary === 'directory' ? 'mkdirSync' : 'writeFileSync';
  const target = join(context.home, '.praxity/toolkit-skills.lock', boundary === 'directory' ? '' : 'pid');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    let count=0; const original=fs.${method}; fs.${method}=function(path,...args){const result=original(path,...args); if(String(path)===${JSON.stringify(target)} && ++count===${boundary === 'reacquired pid' ? 2 : 1}) process.exit(77); return result;}; syncBuiltinESMExports();`);
  const killed = run(); assert.equal(killed.status, 77, killed.stderr);
  assert.ok(existsSync(join(context.home, '.praxity/toolkit-skills.lock')));
  installSkills({ base: context.home, host: 'codex', outputs });
  const state = JSON.parse(readFileSync(ledger, 'utf8'));
  assert.deepEqual(state.hosts, ['claude', 'codex']); assert.equal(state.transaction, undefined); assert.equal(state.lock, undefined);
  assert.ok(existsSync(join(context.home, '.agents/skills/install-praxity/SKILL.md')));
  assert.equal(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')), true);
  assert.equal(existsSync(join(context.home, '.praxity/toolkit-skills.lock')), false);
});
test('canonical adapter generation matches reviewed golden files', t => {
  const { context } = fixture(t);
  const outputs = outputsFor(context);
  const snapshot = Object.fromEntries(Object.entries(outputs).map(([host, files]) => [host, Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]))]));
  assert.deepEqual(snapshot, JSON.parse(readFileSync(join(repository, 'test/golden/adapters.json'), 'utf8')));
  assert.deepEqual(Object.keys(outputs), ['claude', 'codex']);
  assert.equal([...outputs.claude.keys()].some(name => name.includes('/plugins/')), false);
});
test('generator CLI emits two portable host layouts', t => {
  const { root } = fixture(t);
  const output = join(root, 'built adapters');
  const result = spawnSync(process.execPath, [join(repository, 'scripts/build-adapters.mjs'), '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const path of ['claude/.claude/skills/install-praxity/SKILL.md', 'codex/.agents/skills/studio-editor/SKILL.md']) assert.ok(existsSync(join(output, path)));
  const rerun = spawnSync(process.execPath, [join(repository, 'scripts/build-adapters.mjs'), '--output', output], { encoding: 'utf8' });
  assert.equal(rerun.status, 1); assert.match(rerun.stderr, /already exists/);
});
test('tool-owned skills and references are collected unchanged', t => {
  const { context } = fixture(t);
  const tool = join(context.root, 'tool skill');
  mkdirSync(join(tool, 'references'), { recursive: true });
  const skill = '---\nname: praxity-trace\ndescription: Trace a course.\n---\nOwned by Trace.\n';
  writeFileSync(join(tool, 'SKILL.md'), skill);
  writeFileSync(join(tool, 'references/legal.txt'), 'Required notice.\n');
  const outputs = buildAdapters({ source: join(context.root, 'skills'), tools: [tool], packVersion: '0.1.0' });
  assert.equal(outputs.codex.get('.agents/skills/praxity-trace/SKILL.md').toString(), skill);
  assert.equal(outputs.claude.get('.claude/skills/praxity-trace/references/legal.txt').toString(), 'Required notice.\n');
  assert.throws(() => buildAdapters({ source: join(context.root, 'skills'), tools: [tool, tool], packVersion: '0.1.0' }), /Duplicate skill/);
});
test('portable CRLF skills retain their bytes and require real frontmatter', t => {
  const { context } = fixture(t);
  const tool = join(context.root, 'Windows portable skill'); mkdirSync(tool);
  const skill = '---\r\nname: praxity-check\r\ndescription: Check a course.\r\n---\r\nTool-owned instructions.\r\n';
  writeFileSync(join(tool, 'SKILL.md'), skill);
  const options = { source: join(context.root, 'skills'), tools: [tool], packVersion: '0.1.0' };
  assert.equal(buildAdapters(options).codex.get('.agents/skills/praxity-check/SKILL.md').toString(), skill);
  writeFileSync(join(tool, 'SKILL.md'), '---\nname: praxity-check\n---\nNo description.\n');
  assert.throws(() => buildAdapters(options), /Invalid skill frontmatter/);
});
test('install is idempotent and aliases share one adapter while distinct hosts coexist', t => {
  const { context } = fixture(t);
  const options = { base: context.home, otherBase: context.cwd, outputs: outputsFor(context) };
  installSkills({ ...options, host: 't3' });
  installSkills({ ...options, host: 't3' });
  assert.ok(existsSync(join(context.home, '.claude/skills/studio-editor/SKILL.md')));
  installSkills({ ...options, host: 'claude' });
  assert.ok(existsSync(join(context.home, '.claude/skills/studio-editor/SKILL.md')));
  assert.equal(existsSync(join(context.home, '.claude/plugins/praxity/.claude-plugin/plugin.json')), false);
  installSkills({ ...options, host: 'codex' });
  assert.equal(existsSync(join(context.home, '.claude/plugins/praxity/skills/studio-editor/SKILL.md')), false);
  assert.ok(existsSync(join(context.home, '.agents/skills/studio-editor/SKILL.md')));
  assert.deepEqual(JSON.parse(readFileSync(join(context.home, '.praxity/toolkit-skills.json'))).hosts, ['claude', 'codex']);
});
test('unowned skills for a different host coexist; same-host overwrite is refused', t => {
  const { context } = fixture(t);
  const existing = join(context.home, '.claude/skills/install-praxity/SKILL.md');
  mkdirSync(join(context.home, '.claude/skills/install-praxity'), { recursive: true });
  writeFileSync(existing, 'My skill');
  const options = { base: context.home, host: 'codex', outputs: outputsFor(context) };
  installSkills(options);
  assert.equal(readFileSync(existing, 'utf8'), 'My skill');
  assert.equal(existsSync(join(context.home, '.agents/skills/install-praxity/SKILL.md')), true);
  assert.throws(() => installSkills({ ...options, host: 't3' }), /Unowned adapter/);
});
test('modified owned files and malicious ownership paths are preserved', t => {
  const { context } = fixture(t);
  const options = { base: context.home, host: 't3', outputs: outputsFor(context) };
  installSkills(options);
  const file = join(context.home, '.claude/skills/studio-editor/SKILL.md');
  writeFileSync(file, 'My edits');
  assert.throws(() => installSkills({ ...options, host: 'codex' }), /Owned adapter changed/);
  assert.equal(readFileSync(file, 'utf8'), 'My edits');
  writeFileSync(join(context.home, '.praxity/toolkit-skills.json'), JSON.stringify({ owner: 'praxity-toolkit', files: { '../outside.txt': 'abc' } }));
  assert.throws(() => installSkills(options), /Unsafe ownership path/);
});
test('cross-scope installation refuses competing copies', t => {
  const { context } = fixture(t);
  const outputs = outputsFor(context);
  installSkills({ base: context.home, otherBase: context.cwd, host: 't3', outputs });
  assert.throws(() => installSkills({ base: context.cwd, otherBase: context.home, host: 't3', outputs }), /other scope/);
});
test('symlinked adapter roots are refused', t => {
  const { context } = fixture(t);
  const target = join(context.root, 'outside'); mkdirSync(target);
  symlinkSync(target, join(context.home, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => installSkills({ base: context.home, host: 't3', outputs: outputsFor(context) }), /symlink refused/);
});
test('unowned plugin components and untracked other-scope skills block competing installation', t => {
  const { context } = fixture(t);
  const outputs = outputsFor(context);
  mkdirSync(join(context.home, '.claude/plugins/praxity'), { recursive: true });
  writeFileSync(join(context.home, '.claude/plugins/praxity/.mcp.json'), 'User plugin component');
  assert.throws(() => installSkills({ base: context.home, host: 'claude', outputs }), /Unowned competing plugin/);
  mkdirSync(join(context.cwd, '.agents/skills/studio-editor'), { recursive: true });
  writeFileSync(join(context.cwd, '.agents/skills/studio-editor/SKILL.md'), 'Project skill');
  assert.throws(() => installSkills({ base: context.home, otherBase: context.cwd, host: 'codex', outputs }), /other scope/);
});
test('launcher installs selected scope; doctor checks two physical adapters', async t => {
  const { context } = fixture(t);
  await runCli(['skills', 'install', '--host', 't3', '--scope', 'project'], context, { print: () => {} });
  const result = doctor(context, () => ({ code: 0, stdout: 'v24.21.0', stderr: '' }));
  assert.equal(result.items.find(item => item.id === 'host.claude.project').status, 'ok');
  assert.equal(result.items.find(item => item.id === 'host.codex.project').status, 'not-installed');
  assert.equal(result.items.some(item => item.id.startsWith('host.t3.')), false);
});

for (const name of ['.claude/skills/../../Documents/notes.txt', '.agents/skills/../../../Documents/notes.txt', '/Documents/notes.txt', 'C:/Documents/notes.txt', '.claude/skills/../skills/studio-editor/SKILL.md']) test(`skills ledger refuses noncanonical adapter path ${name}`, t => {
  const { context } = fixture(t), victim = join(context.home, 'Documents/notes.txt');
  mkdirSync(join(context.home, 'Documents')); writeFileSync(victim, 'USER FILE');
  mkdirSync(join(context.home, '.praxity'));
  writeFileSync(join(context.home, '.praxity/toolkit-skills.json'), JSON.stringify({ owner: 'praxity-toolkit', files: { [name]: createHash('sha256').update('USER FILE').digest('hex') } }));
  assert.throws(() => installSkills({ base: context.home, host: 't3', outputs: outputsFor(context) }), /Unsafe ownership path/);
  assert.equal(readFileSync(victim, 'utf8'), 'USER FILE');
  assert.equal(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')), false);
});
test('dangling symlink in an adapter ancestor is refused before mutations', t => {
  const { context } = fixture(t);
  symlinkSync(join(context.root, 'missing'), join(context.home, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => installSkills({ base: context.home, host: 't3', outputs: outputsFor(context) }), /symlink refused/);
});

for (const obstacle of ['.praxity/toolkit-skills.json.tmp', '.claude/plugins/praxity/skills/install-praxity/SKILL.md.praxity-tmp']) test(`switch preflights ${obstacle} and leaves the previous adapter retryable`, t => {
  const { context } = fixture(t), options = { base: context.home, outputs: outputsFor(context) };
  installSkills({ ...options, host: 't3' });
  const file = join(context.home, obstacle); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'USER FILE');
  const before = readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8');
  assert.throws(() => installSkills({ ...options, host: 'claude' }));
  assert.equal(readFileSync(file, 'utf8'), 'USER FILE');
  assert.equal(readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8'), before);
  assert.ok(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')));
});

for (const phase of ['stage', 'remove']) test(`interrupted adapter addition recovers after ${phase} without competing copies`, async t => {
  const { context } = fixture(t);
  const references = join(context.root, 'skills/install-praxity/references'); mkdirSync(references);
  for (let i = 0; i < 300; i++) writeFileSync(join(references, `${i}.txt`), `fixture ${i}\n`);
  const options = { base: context.home, outputs: outputsFor(context) };
  installSkills({ ...options, host: 't3' });
  const module = process.env.TOOLKIT_SKILLS_MODULE ?? join(repository, 'src/skills.mjs');
  const code = `import { buildAdapters, installSkills } from ${JSON.stringify(pathToFileURL(module).href)};
    installSkills({base:${JSON.stringify(context.home)},host:'codex',outputs:buildAdapters({source:${JSON.stringify(join(context.root, 'skills'))},packVersion:'0.1.0'})});`;
  let killed = false, stderr = '';
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const watcher = watch(join(context.home, '.praxity'), (_event, name) => {
    if (killed || name !== 'toolkit-skills.json') return;
    const state = JSON.parse(readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8'));
    if (state.transaction?.phase === phase) { killed = true; child.kill('SIGKILL'); }
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Adapter child did not finish')); }, 20_000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
  } finally { watcher.close(); }
  assert.ok(killed, `Did not observe durable ${phase} transaction: ${stderr}`);
  installSkills({ ...options, host: 'codex' });
  const state = JSON.parse(readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8'));
  assert.deepEqual(state.hosts, ['claude', 'codex']); assert.equal(state.transaction, undefined);
  assert.ok(existsSync(join(context.home, '.agents/skills/install-praxity/SKILL.md')));
  assert.equal(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')), true);
  assert.equal(existsSync(join(context.home, '.praxity/toolkit-skills.lock')), false);
});

test('doctor names skills missing after an upgrade, and refresh adds them without touching user skills', async t => {
  const { context } = fixture(t), quiet = { print: () => {} };
  await runCli(['skills', 'install', '--host', 'claude', '--scope', 'user'], context, quiet);
  const userSkill = join(context.home, '.claude/skills/my-notes/SKILL.md');
  mkdirSync(join(userSkill, '..')); writeFileSync(userSkill, 'USER SKILL');
  // The upgraded pack adds Import and its skill.
  fakeTool(context, 'import');
  mkdirSync(join(context.root, 'tools/import/skill'));
  writeFileSync(join(context.root, 'tools/import/skill/SKILL.md'), '---\nname: praxity-import\ndescription: Convert a course.\n---\nImport skill.\n');
  const host = () => doctor(context, () => ({ code: 0, stdout: 'v24.21.0', stderr: '' })).items.find(item => item.id === 'host.claude.user');
  assert.deepEqual(host(), { id: 'host.claude.user', status: 'partial', message: 'Missing skills: praxity-import.', fix: 'praxity skills install --host claude --scope user' });
  await runCli(['skills', 'refresh', '--scope', 'user'], context, quiet);
  assert.equal(host().status, 'ok');
  assert.equal(readFileSync(userSkill, 'utf8'), 'USER SKILL');
  assert.deepEqual(readState(context.home).hosts, ['claude']);
  assert.equal(existsSync(join(context.home, '.agents')), false);
  await runCli(['skills', 'refresh', '--scope', 'project'], context, quiet);
  assert.equal(existsSync(join(context.cwd, '.praxity')), false);
});

test('doctor reports a changed toolkit skill as partial', async t => {
  const { context } = fixture(t);
  await runCli(['skills', 'install', '--host', 'codex', '--scope', 'project'], context, { print: () => {} });
  writeFileSync(join(context.cwd, '.agents/skills/studio-editor/SKILL.md'), 'Edited');
  const item = doctor(context, () => ({ code: 0, stdout: 'v24.21.0', stderr: '' })).items.find(item => item.id === 'host.codex.project');
  assert.equal(item.status, 'partial');
  assert.equal(item.message, 'Changed or out-of-date skills: studio-editor.');
  assert.equal(item.fix, 'Move your edited copies of studio-editor out of .agents/skills, then run praxity skills install --host codex --scope project');
  // Following the fix works: install recreates the moved skill.
  renameSync(join(context.cwd, '.agents/skills/studio-editor'), join(context.cwd, 'studio-editor edited'));
  await runCli(['skills', 'install', '--host', 'codex', '--scope', 'project'], context, { print: () => {} });
  assert.equal(doctor(context, () => ({ code: 0, stdout: 'v24.21.0', stderr: '' })).items.find(item => item.id === 'host.codex.project').status, 'ok');
  assert.equal(readFileSync(join(context.cwd, 'studio-editor edited/SKILL.md'), 'utf8'), 'Edited');
});

test('doctor sees an rc.1 t3 install as the claude adapter, and refresh adds its missing skills', async t => {
  const { context } = fixture(t), printed = [];
  const files = legacyInstall(context, 't3');
  fakeTool(context, 'import');
  mkdirSync(join(context.root, 'tools/import/skill'));
  writeFileSync(join(context.root, 'tools/import/skill/SKILL.md'), '---\nname: praxity-import\ndescription: Convert a course.\n---\nImport skill.\n');
  const host = () => doctor(context, () => ({ code: 0, stdout: 'v24.21.0', stderr: '' })).items.find(item => item.id === 'host.claude.user');
  assert.deepEqual(host(), { id: 'host.claude.user', status: 'partial', message: 'Missing skills: praxity-import.', fix: 'praxity skills install --host claude --scope user' });
  await runCli(['skills', 'refresh', '--scope', 'user'], context, { print: line => printed.push(line) });
  assert.deepEqual(printed, ['Refreshed claude skills at user scope. Restart the host to load them.']);
  assert.equal(host().status, 'ok');
  assert.deepEqual(readState(context.home).hosts, ['claude']);
  for (const [name, bytes] of files) assert.deepEqual(readFileSync(join(context.home, name)), bytes);
});

test('refresh reports a schema-1 claude record instead of migrating it', async t => {
  const { context } = fixture(t), printed = [];
  legacyInstall(context, 'claude');
  const before = readFileSync(join(context.home, '.praxity/toolkit-skills.json'));
  await runCli(['skills', 'refresh', '--scope', 'user'], context, { print: line => printed.push(line) });
  assert.deepEqual(printed, ['Skills at user scope use an older ownership record and were not refreshed. Stop host sessions, then run praxity skills install --host claude --scope user.']);
  assert.deepEqual(readFileSync(join(context.home, '.praxity/toolkit-skills.json')), before);
  assert.ok(existsSync(join(context.home, '.claude/plugins/praxity/.claude-plugin/plugin.json')));
});
