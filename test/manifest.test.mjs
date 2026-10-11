import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { examplePack, realPack, repository } from './helpers.mjs';
import { validateManifest, validateReleaseManifest, installationPlan } from '../src/manifest.mjs';
import { loadSchema, validateSchema } from '../src/schema.mjs';

test('real pack validates and every published archive has a complete contract', () => {
  const pack = realPack();
  assert.deepEqual(validateSchema(pack, loadSchema('pack')), []);
  assert.deepEqual(validateManifest(pack), []);
  assert.deepEqual(validateReleaseManifest(pack), []);
  for (const artifact of [...Object.values(pack.runtimes), ...pack.tools]) {
    for (const [platform, archive] of Object.entries(artifact.archives)) {
      if (archive.status !== 'published') continue;
      for (const field of ['url', 'sha256', 'format', 'stripComponents']) {
        assert.ok(Object.hasOwn(archive, field), `${artifact.id ?? artifact.version}/${platform}: missing ${field}`);
      }
    }
  }
});

test('real pack pins every published tool archive to its toolkit release', () => {
  const pack = realPack();
  const prefix = `https://github.com/Praxity/praxity-toolkit/releases/download/v${pack.version}/`;
  for (const tool of pack.tools) {
    for (const archive of Object.values(tool.archives)) {
      if (archive.status === 'published') assert.ok(archive.url.startsWith(prefix), tool.id);
    }
  }
});
test('unpublished fixture tools are omitted from the installation plan', () => {
  const pack = examplePack();
  assert.deepEqual(validateManifest(pack), []);
  assert.deepEqual(installationPlan(pack, 'darwin-arm64').map(item => item.id), ['node', 'typst']);
  assert.throws(() => installationPlan(pack, 'linux-x64'), /Unsupported platform/);
});

for (const platform of ['darwin-arm64', 'darwin-x64']) test(`installation plan selects ${platform} archives`, () => {
  const pack = realPack();
  const plan = installationPlan(pack, platform);
  assert.equal(plan.find(entry => entry.id === 'node').url, `https://nodejs.org/dist/v24.21.0/node-v24.21.0-${platform}.tar.gz`);
  assert.equal(plan.find(entry => entry.id === 'studio').url, `https://github.com/Praxity/praxity-toolkit/releases/download/v0.1.0/praxity-studio-cli-0.3.0-main.b4962141-${platform}.tar.gz`);
});

test('every declared platform requires every tool archive', () => {
  for (const tool of realPack().tools) {
    const pack = realPack();
    pack.platforms = ['darwin-arm64', 'darwin-x64'];
    delete pack.tools.find(entry => entry.id === tool.id).archives['darwin-x64'];
    assert.ok(validateManifest(pack).some(error => error.includes(`${tool.id}/archives/darwin-x64: required`)));
  }
});

test('portable tools reuse their archives on both macOS architectures', () => {
  const pack = realPack();
  for (const id of ['check', 'trace', 'print', 'import']) {
    const tool = pack.tools.find(tool => tool.id === id);
    assert.equal(tool.archives['darwin-x64'].status, 'published');
    assert.deepEqual(tool.archives['darwin-x64'], tool.archives['darwin-arm64'], id);
  }
});

test('manifest cannot omit a tool from the pack', () => {
  const pack = realPack();
  pack.tools.pop();
  assert.ok(validateManifest(pack).length);
});

test('release validation refuses unpublished tool placeholders on a supported platform', () => {
  const pack = examplePack();
  pack.platforms = ['darwin-arm64'];
  assert.deepEqual(validateManifest(pack), []);
  assert.ok(validateReleaseManifest(pack).some(error => error.includes('unpublished')));
  for (const tool of pack.tools) for (const platform of pack.platforms) {
    tool.archives[platform] = { ...pack.runtimes.node.archives[platform] };
  }
  assert.deepEqual(validateReleaseManifest(pack), []);
  // Unpublished platforms outside the release remain allowed.
  delete pack.tools[0].archives['darwin-x64'];
  pack.platforms.push('darwin-x64');
  assert.ok(validateReleaseManifest(pack).length);
});
test('published archive has a complete executable contract', () => {
  const pack = examplePack();
  pack.tools[0].archives['darwin-arm64'] = { status: 'published', url: 'file:///tmp/tool%20archive.tar.gz', sha256: 'a'.repeat(64), format: 'tar.gz', stripComponents: 1 };
  assert.deepEqual(validateManifest(pack), []);
  const plan = installationPlan(pack, 'darwin-arm64');
  assert.deepEqual(plan.map(item => item.id), ['node', 'typst', 'studio']);
  assert.equal(plan.find(item => item.id === 'studio').entry, 'praxity.mjs');
});
test('runtime hashes match the preserved official release evidence', () => {
  const pack = realPack();
  const checksums = readFileSync(join(repository, 'docs/provenance/node-v24.21.0-SHASUMS256.txt'), 'utf8');
  const typst = JSON.parse(readFileSync(join(repository, 'docs/provenance/typst-v0.15.1-assets.json'), 'utf8'));
  for (const archive of Object.values(pack.runtimes.node.archives)) {
    const file = new URL(archive.url).pathname.split('/').at(-1);
    assert.ok(checksums.split(/\r?\n/).includes(`${archive.sha256}  ${file}`));
  }
  for (const archive of Object.values(pack.runtimes.typst.archives)) {
    const asset = typst.assets.find(asset => asset.browser_download_url === archive.url);
    assert.equal(asset?.digest, `sha256:${archive.sha256}`);
  }
});
const bad = {
  'unknown field': p => p.surprise = 1,
  'unsafe version': p => p.version = '../../outside',
  'Node 23': p => p.runtimes.node.version = '23.1.0',
  'Node below minimum': p => p.runtimes.node.version = '24.17.9',
  'Node 25': p => p.runtimes.node.version = '25.0.0',
  'bad checksum': p => p.runtimes.node.archives['darwin-arm64'].sha256 = 'BAD',
  'insecure URL': p => p.runtimes.node.archives['darwin-arm64'].url = 'http://example.com/node.tgz',
  'missing runtime entry': p => delete p.runtimes.typst.entry['darwin-arm64'],
  'unsupported platform': p => p.platforms.push('linux-arm64'),
  'duplicate platform': p => p.platforms.push('darwin-arm64'),
  'duplicate tool': p => p.tools.push(structuredClone(p.tools[0])),
  'path traversal': p => p.tools[0].entry = '../outside',
  'missing platform archive': p => delete p.tools[0].archives['darwin-arm64'],
  'unpublished without reason': p => delete p.tools[0].archives['darwin-arm64'].reason,
  'invented unpublished URL': p => p.tools[0].archives['darwin-arm64'].url = 'https://example.com/invented.tgz',
  'published without checksum': p => p.tools[0].archives['darwin-arm64'] = { status: 'published', url: 'https://example.com/tool.tgz', format: 'tar.gz', stripComponents: 1 },
};
for (const [name, mutate] of Object.entries(bad)) test(`manifest rejects ${name}`, () => {
  const pack = examplePack(); mutate(pack);
  assert.ok(validateManifest(pack).length, name);
});
test('doctor wire schema requires stable fields and known statuses', () => {
  const schema = loadSchema('doctor');
  const result = { schemaVersion: 2, packVersion: '0.1.0', exitCode: 1, items: [{ id: 'tool.check', status: 'failed', message: 'broken', fix: 'praxity setup check' }] };
  assert.deepEqual(validateSchema(result, schema), []);
  result.items[0].status = 'maybe';
  assert.ok(validateSchema(result, schema).length);
  result.items[0].status = 'ok'; delete result.items[0].fix;
  assert.ok(validateSchema(result, schema).length);
  assert.throws(() => validateSchema({}, { unexpectedVocabulary: true }), /Unsupported schema keyword/);
});

test('all archive entry and notices paths reference the schema owning path grammar', () => {
  const schema = JSON.parse(readFileSync(join(repository, 'schemas/pack.schema.json'), 'utf8'));
  const paths = [schema.$defs.tool.properties.entry, schema.$defs.tool.properties.notices, schema.$defs.tool.properties.skillPath,
    schema.$defs.runtime.properties.notices, ...Object.values(schema.$defs.runtime.properties.entry.properties)];
  assert.equal(paths.length, 8);
  for (const path of paths) assert.deepEqual(path, { $ref: '#/$defs/path' });
});
