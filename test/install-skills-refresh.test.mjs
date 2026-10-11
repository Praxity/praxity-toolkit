import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installation, archive, posix, quote, shell, replaceInstalled } from './installer-fixture.mjs';

const passed = result => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

test('an upgrade refreshes installed host skills and leaves user skills and other hosts alone', t => {
  const setup = installation(t);
  passed(setup.install());
  assert.equal(existsSync(join(setup.home, '.claude')), false);
  assert.equal(existsSync(join(setup.home, '.praxity/toolkit-skills.json')), false);
  passed(shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} skills install --host claude --scope user`, { env: setup.env }));
  const skills = join(setup.home, '.claude/skills'), userSkill = join(skills, 'my-notes/SKILL.md');
  mkdirSync(dirname(userSkill)); writeFileSync(userSkill, 'USER SKILL');
  assert.equal(existsSync(join(skills, 'fixture-import')), false);
  // The next pack adds Import, whose archive ships a skill.
  const tool = setup.pack.tools.find(tool => tool.id === 'import'), payload = join(setup.root, 'fake import');
  for (const [file, bytes] of [[tool.entry, 'console.log("import");\n'], [tool.notices, 'Tool legal fixture\n'],
    [join(tool.skillPath, 'SKILL.md'), '---\nname: fixture-import\ndescription: Convert a course.\n---\nTool-owned skill.\n']]) {
    mkdirSync(dirname(join(payload, file)), { recursive: true }); writeFileSync(join(payload, file), bytes);
  }
  tool.archives['darwin-arm64'] = archive(payload, join(setup.root, 'import archive.tar.gz'));
  setup.pack.version = '0.2.0'; setup.save();
  const upgrade = setup.install(); passed(upgrade);
  assert.match(upgrade.stdout, /Refreshed claude skills at user scope/);
  assert.ok(existsSync(join(skills, 'fixture-import/SKILL.md')));
  assert.equal(readFileSync(userSkill, 'utf8'), 'USER SKILL');
  assert.equal(existsSync(join(setup.home, '.agents')), false);
});

test('an upgrade refreshes changed tool skills for both recorded adapters', t => {
  const setup = installation(t);
  passed(setup.install());
  for (const host of ['t3', 'codex']) {
    passed(shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} skills install --host ${host} --scope user`, { env: setup.env }));
  }
  const payload = join(setup.root, 'fake studio');
  const tool = setup.pack.tools.find(tool => tool.id === 'studio');
  const updated = '---\nname: prax-format\ndescription: Write a course.\n---\nUpdated tool-owned skill.\n';
  writeFileSync(join(payload, tool.skillPath, 'SKILL.md'), updated);
  tool.archives['darwin-arm64'] = archive(payload, join(setup.root, 'studio upgrade.tar.gz'));
  setup.pack.version = '0.2.0'; setup.save();
  passed(setup.install());
  for (const folder of ['.claude/skills', '.agents/skills']) {
    assert.equal(readFileSync(join(setup.home, folder, 'prax-format/SKILL.md'), 'utf8'), updated);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(setup.home, '.praxity/toolkit-skills.json'))).hosts, ['claude', 'codex']);
});

test('a refused skill refresh still activates the pack and names the refresh command', t => {
  const setup = installation(t);
  passed(setup.install());
  passed(shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} skills install --host claude --scope user`, { env: setup.env }));
  const edited = join(setup.home, '.claude/skills/prax-format/SKILL.md');
  writeFileSync(edited, 'MY EDITS');
  setup.pack.version = '0.2.0'; setup.save();
  const upgrade = setup.install(); passed(upgrade);
  assert.match(upgrade.stderr, /Owned adapter changed/);
  assert.match(upgrade.stderr, /then run praxity skills refresh --scope user\. Their ownership record is ~\/\.praxity\/toolkit-skills\.json\./);
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8'), '0.2.0\n0.1.0\n');
  assert.equal(readFileSync(edited, 'utf8'), 'MY EDITS');
});

test('reactivating a pack whose CLI predates skills refresh skips the refresh quietly', t => {
  const setup = installation(t);
  passed(setup.install());
  // Packs before 0.1.0 answer skills refresh with their usage line.
  replaceInstalled(setup, '0.1.0', 'src/cli.mjs', "console.error('Usage: praxity skills install|uninstall'); process.exit(1);\n");
  const rerun = setup.install(); passed(rerun);
  assert.doesNotMatch(rerun.stderr, /Usage|not refreshed/);
  assert.match(rerun.stdout, /Installed pack 0\.1\.0/);
});
