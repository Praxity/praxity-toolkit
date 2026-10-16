import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { fixture, repository } from './helpers.mjs';

// Exercise the workflow's actual manifest conversion without GitHub credentials.
const workflow = readFileSync(join(repository, '.github/workflows/ci.yml'), 'utf8');
const conversion = workflow.match(/<<'NODE'\r?\n([\s\S]*?)\r?\n\s*NODE\r?\n/)?.[1];

test('CI confines draft push permission to manual staging without persisted credentials', () => {
  const staging = workflow.split('  stage-release-assets:\n')[1]?.split('  offline:\n')[0];
  assert.ok(staging);
  assert.match(staging, /if: github\.event_name == 'workflow_dispatch' && inputs\.stage_release_assets/);
  assert.match(staging, /persist-credentials: false/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.match(staging, /contents: write/);
  assert.doesNotMatch(staging, /node --test|sh install\.sh/);
});

function draft(t) {
  const { root, pack } = fixture(t);
  mkdirSync(join(root, 'assets'));
  pack.tools[0].archives['darwin-arm64'] = {
    status: 'published',
    url: 'https://github.com/Praxity/rubato/releases/download/v0.1.0/tool.tar.gz',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    format: 'tar.gz', stripComponents: 1,
  };
  writeFileSync(join(root, 'assets/tool.tar.gz'), '');
  const convert = () => {
    assert.ok(conversion, 'Workflow must verify draft assets');
    writeFileSync(join(root, 'pack.json'), JSON.stringify(pack));
    return spawnSync(process.execPath, ['--input-type=module', '-e', conversion], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, TASK_HOME: root, GITHUB_REPOSITORY: 'Praxity/rubato' },
    });
  };
  return { root, pack, archive: pack.tools[0].archives['darwin-arm64'], convert };
}

test('CI draft conversion verifies assets and changes only published tool URLs', t => {
  const { root, pack, convert } = draft(t);
  const result = convert();
  assert.equal(result.status, 0, result.stderr);
  const expected = structuredClone(pack);
  expected.tools[0].archives['darwin-arm64'].url = pathToFileURL(join(root, 'assets/tool.tar.gz')).href;
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'pack-local.json'))), expected);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'pack.json'))), pack);
});

for (const [name, mutate] of [
  ['tampered archive', ({ root }) => writeFileSync(join(root, 'assets/tool.tar.gz'), 'tampered')],
  ['wrong release', ({ archive }) => { archive.url = archive.url.replace('v0.1.0/', 'v0.1.1/'); }],
  ['wrong repository', ({ archive }) => { archive.url = archive.url.replace('Praxity/rubato/', 'Praxity/another-pack/'); }],
  ['escaping asset name', ({ archive }) => { archive.url = archive.url.replace('tool.tar.gz', '../tool.tar.gz'); }],
]) test(`CI draft conversion refuses ${name}`, t => {
  const input = draft(t);
  mutate(input);
  assert.notEqual(input.convert().status, 0);
  assert.throws(() => readFileSync(join(input.root, 'pack-local.json')), { code: 'ENOENT' });
});
