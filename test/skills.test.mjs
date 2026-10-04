import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAdapters, installSkills } from '../src/skills.mjs';
import { runCli } from '../src/cli.mjs';
import { doctor } from '../src/doctor.mjs';
import { fixture, repository } from './helpers.mjs';

const outputsFor = context => buildAdapters({ source: join(context.root, 'skills'), packVersion: context.pack.version });
test('canonical adapter generation matches reviewed golden files', t => {
  const { context } = fixture(t);
  const outputs = outputsFor(context);
  const snapshot = Object.fromEntries(Object.entries(outputs).map(([host, files]) => [host, Object.fromEntries([...files].map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]))]));
  assert.deepEqual(snapshot, JSON.parse(readFileSync(join(repository, 'test/golden/adapters.json'), 'utf8')));
  const manifest = JSON.parse(outputs.claude.get('.claude/plugins/praxity/.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'praxity'); assert.equal(manifest.version, '0.1.0');
  assert.equal(Object.hasOwn(manifest, 'license'), false);
});
test('generator CLI emits plugin and portable host paths', t => {
  const { root } = fixture(t);
  const output = join(root, 'built adapters');
  const result = spawnSync(process.execPath, [join(repository, 'scripts/build-adapters.mjs'), '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const path of ['t3/.claude/skills/install-praxity/SKILL.md', 'codex/.agents/skills/studio-editor/SKILL.md', 'claude/.claude/plugins/praxity/.claude-plugin/plugin.json']) assert.ok(existsSync(join(output, path)));
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
  assert.equal(outputs.t3.get('.claude/skills/praxity-trace/references/legal.txt').toString(), 'Required notice.\n');
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
test('install is idempotent and switching adapters removes only owned copies', t => {
  const { context } = fixture(t);
  const options = { base: context.home, otherBase: context.cwd, outputs: outputsFor(context) };
  installSkills({ ...options, host: 't3' });
  installSkills({ ...options, host: 't3' });
  assert.ok(existsSync(join(context.home, '.claude/skills/studio-editor/SKILL.md')));
  installSkills({ ...options, host: 'claude' });
  assert.equal(existsSync(join(context.home, '.claude/skills/studio-editor/SKILL.md')), false);
  assert.ok(existsSync(join(context.home, '.claude/plugins/praxity/.claude-plugin/plugin.json')));
  installSkills({ ...options, host: 'codex' });
  assert.equal(existsSync(join(context.home, '.claude/plugins/praxity/skills/studio-editor/SKILL.md')), false);
  assert.ok(existsSync(join(context.home, '.agents/skills/studio-editor/SKILL.md')));
});
test('unowned files and competing host skills are refused before mutation', t => {
  const { context } = fixture(t);
  const existing = join(context.home, '.claude/skills/install-praxity/SKILL.md');
  mkdirSync(join(context.home, '.claude/skills/install-praxity'), { recursive: true });
  writeFileSync(existing, 'My skill');
  const options = { base: context.home, host: 'codex', outputs: outputsFor(context) };
  assert.throws(() => installSkills(options), /Unowned competing/);
  assert.equal(readFileSync(existing, 'utf8'), 'My skill');
  assert.equal(existsSync(join(context.home, '.agents/skills/install-praxity/SKILL.md')), false);
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
  assert.throws(() => installSkills({ base: context.home, otherBase: context.cwd, host: 't3', outputs }), /other scope/);
});
test('launcher installs selected scope; doctor checks picker and plugin files', async t => {
  const { context } = fixture(t);
  await runCli(['skills', 'install', '--host', 't3', '--scope', 'project'], context, { print: () => {} });
  const result = doctor(context, () => ({ code: 0, stdout: 'v24.21.0', stderr: '' }));
  assert.equal(result.items.find(item => item.id === 'host.t3.project').status, 'ok');
  assert.equal(result.items.find(item => item.id === 'host.claude.project').status, 'not-installed');
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
