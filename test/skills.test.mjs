import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, watch, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { buildAdapters, installSkills } from '../src/skills.mjs';
import { runCli } from '../src/cli.mjs';
import { doctor } from '../src/doctor.mjs';
import { fixture, repository } from './helpers.mjs';

const outputsFor = context => buildAdapters({ source: join(context.root, 'skills'), packVersion: context.pack.version });

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
  assert.equal(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')), false);
  assert.equal(readFileSync(join(context.home, '.agents/skills/install-praxity/SKILL.md'), 'utf8'), outputs.codex.get('.agents/skills/install-praxity/SKILL.md').toString());
  assert.equal(JSON.parse(readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8')).transaction, undefined);
});

for (const boundary of ['directory', 'pid', 'reacquired pid']) test(`skills switch recovers a crash after its ${boundary} lock write`, t => {
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
  assert.equal(state.host, 'codex'); assert.equal(state.transaction, undefined); assert.equal(state.lock, undefined);
  assert.ok(existsSync(join(context.home, '.agents/skills/install-praxity/SKILL.md')));
  assert.equal(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')), false);
  assert.equal(existsSync(join(context.home, '.praxity/toolkit-skills.lock')), false);
});
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

for (const phase of ['stage', 'remove']) test(`interrupted adapter switch recovers after ${phase} without competing copies`, async t => {
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
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Switch child did not finish')); }, 20_000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
  } finally { watcher.close(); }
  assert.ok(killed, `Did not observe durable ${phase} transaction: ${stderr}`);
  installSkills({ ...options, host: 'codex' });
  const state = JSON.parse(readFileSync(join(context.home, '.praxity/toolkit-skills.json'), 'utf8'));
  assert.equal(state.host, 'codex'); assert.equal(state.transaction, undefined);
  assert.ok(existsSync(join(context.home, '.agents/skills/install-praxity/SKILL.md')));
  assert.equal(existsSync(join(context.home, '.claude/skills/install-praxity/SKILL.md')), false);
  assert.equal(existsSync(join(context.home, '.praxity/toolkit-skills.lock')), false);
});
