import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installation, archive, posix, quote, shell } from './installer-fixture.mjs';

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
