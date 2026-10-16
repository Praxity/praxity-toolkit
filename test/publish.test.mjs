import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, realPack, repository } from './helpers.mjs';
import { githubRelease, publishStudioPack } from '../scripts/publish-studio-pack.mjs';
import { validateReleaseManifest } from '../src/manifest.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = '1234567890abcdef1234567890abcdef12345678';
function candidate(t, mutate = () => {}, mutateInventory = () => {}) {
  const { root } = fixture(t), archives = join(root, 'archives');
  mkdirSync(archives);
  for (const arch of ['arm64', 'x64']) {
    const staging = join(root, arch), payload = join(staging, 'studio-cli');
    mkdirSync(payload, { recursive: true });
    const files = {
      'praxity.mjs': 'console.log("ok");', 'package.json': '{"version":"0.3.0"}',
      'legal/LICENSE': 'PolyForm Perimeter License 1.0.1',
      'legal/LICENSING.md': 'Terms', 'editor/index.html': '<html></html>',
      'typst/typst': 'native compiler', 'licenses/example/LICENSE': 'MIT',
    };
    const inventory = { sourceRevision: sha, sourceTreeDirty: false, platform: 'darwin', arch,
      version: '0.3.0', entrypoint: 'praxity.mjs', legal: ['legal/LICENSE', 'legal/LICENSING.md'],
      dependencies: [{ name: 'example', notices: ['licenses/example/LICENSE'] }] };
    mutate({ arch, files, inventory });
    inventory.files = Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes), component: 'studio-module' }));
    inventory.payloadSha256 = hash(JSON.stringify(inventory.files));
    mutateInventory(inventory);
    for (const [name, bytes] of Object.entries({ ...files, 'inventory.json': JSON.stringify(inventory) })) {
      mkdirSync(join(payload, name, '..'), { recursive: true });
      writeFileSync(join(payload, name), bytes);
    }
    const name = `praxity-cli-0.3.0-macos-${arch}.tar.gz`;
    execFileSync('tar', ['-czf', join(archives, name), '-C', staging, 'studio-cli']);
    writeFileSync(join(archives, `${name}.sha256`), `${hash(readFileSync(join(archives, name)))} *${name}\n`);
  }
  const calls = [];
  const release = {
    async assertNewImmutableRelease(tag) { calls.push(['check', tag]); },
    async createDraft(tag) { calls.push(['draft', tag]); },
    async upload(tag, assets) { calls.push(['upload', assets.map(file => file.split(/[\\/]/).at(-1))]); },
    async activate(tag) { calls.push(['activate', tag]); },
  };
  const options = { version: '0.1.2', studioSha: sha, archivesDir: archives,
    outputDir: join(root, 'output'), repositoryRoot: repository, dryRun: true };
  return { root, calls, release, options };
}

test('dry-run creates a schema-valid pack with exact hashes and tested SHA, without publishing', async t => {
  const { options, calls, release } = candidate(t);
  const pack = await publishStudioPack(options, release);
  assert.equal(pack.version, '0.1.2');
  const studio = pack.tools.find(tool => tool.id === 'studio');
  assert.equal(studio.sourceRevision, sha);
  assert.equal(studio.version, '0.3.0-main.12345678');
  for (const arch of ['arm64', 'x64']) {
    const name = `praxity-cli-0.3.0-macos-${arch}.tar.gz`;
    assert.equal(studio.archives[`darwin-${arch}`].url, `https://github.com/Praxity/rubato/releases/download/v0.1.2/${name}`);
    assert.equal(studio.archives[`darwin-${arch}`].sha256, hash(readFileSync(join(options.archivesDir, name))));
  }
  assert.deepEqual(validateReleaseManifest(pack), []);
  assert.deepEqual(calls, []);
  assert.deepEqual(readdirSync(options.outputDir).sort(), ['SHA256SUMS', 'pack.json', 'rubato-0.1.2.tar.gz']);
  const bootstrap = join(options.outputDir, 'rubato-0.1.2.tar.gz');
  const embedded = JSON.parse(execFileSync('tar', ['-xOf', bootstrap, 'rubato/pack.json']));
  assert.deepEqual(embedded, pack);
  const names = execFileSync('tar', ['-tf', bootstrap], { encoding: 'utf8' });
  assert.match(names, /rubato\/install.sh/);
  assert.doesNotMatch(names, /(?:\.git\/|test\/|build-inputs|studio-cli-review)/);
  const original = realPack();
  assert.equal(original.version, '0.1.1');
  assert.ok(pack.tools.find(tool => tool.id === 'check').archives['darwin-arm64'].url.startsWith('https://github.com/Praxity/rubato/'));
});

test('publication creates a new draft, uploads an allowlist, then activates last', async t => {
  const { options, calls, release } = candidate(t);
  await publishStudioPack({ ...options, dryRun: false }, release);
  assert.deepEqual(calls.map(call => call[0]), ['check', 'draft', 'upload', 'activate']);
  assert.deepEqual(calls[2][1].sort(), ['SHA256SUMS', 'pack.json', 'praxity-cli-0.3.0-macos-arm64.tar.gz', 'praxity-cli-0.3.0-macos-x64.tar.gz', 'rubato-0.1.2.tar.gz']);
});

for (const [name, mutate] of [
  ['wrong Studio SHA', ({ inventory }) => { inventory.sourceRevision = 'f'.repeat(40); }],
  ['dirty build', ({ inventory }) => { inventory.sourceTreeDirty = true; }],
  ['wrong native architecture', ({ inventory }) => { inventory.arch = 'riscv64'; }],
  ['missing legal notice', ({ files }) => { delete files['legal/LICENSE']; }],
  ['missing upstream notice', ({ files }) => { delete files['licenses/example/LICENSE']; }],
  ['private checkout', ({ files }) => { files['apps/desktop/private.ts'] = 'source'; }],
  ['review provenance', ({ files }) => { files['studio-cli-review/build-inputs.json'] = '{}'; }],
  ['source map', ({ files }) => { files['editor/main.js.map'] = '{}'; }],
  ['private browser source', ({ files }) => { files['editor/private.ts'] = 'source'; }],
  ['private path', ({ files }) => { files['praxity.mjs'] = '/Users/private/source'; }],
  ['hidden git history', ({ files }) => { files['editor/.git/config'] = 'private'; }],
]) test(`failed verification publishes nothing: ${name}`, async t => {
  const { options, calls, release } = candidate(t, mutate);
  await assert.rejects(publishStudioPack({ ...options, dryRun: false }, release));
  assert.deepEqual(calls, []);
  assert.equal(existsSync(options.outputDir), false);
});

for (const [name, mutate] of [
  ['bad inventory digest', inventory => { inventory.payloadSha256 = '0'.repeat(64); }],
  ['wrong payload hash', inventory => { inventory.files[0].sha256 = '0'.repeat(64); inventory.payloadSha256 = hash(JSON.stringify(inventory.files)); }],
  ['omitted payload file', inventory => { inventory.files.pop(); inventory.payloadSha256 = hash(JSON.stringify(inventory.files)); }],
  ['duplicate inventory file', inventory => { inventory.files.push(inventory.files[0]); inventory.payloadSha256 = hash(JSON.stringify(inventory.files)); }],
  ['empty notices', inventory => { inventory.dependencies[0].notices = []; }],
  ['wrong entrypoint', inventory => { inventory.entrypoint = 'other.mjs'; }],
  ['wrong platform', inventory => { inventory.platform = 'linux'; }],
  ['invalid Studio version', inventory => { inventory.version = '../source'; }],
]) test(`invalid inventory cannot publish: ${name}`, async t => {
  const { options, calls, release } = candidate(t, undefined, mutate);
  await assert.rejects(publishStudioPack({ ...options, dryRun: false }, release));
  assert.deepEqual(calls, []);
  assert.equal(existsSync(options.outputDir), false);
});

test('GitHub adapter requires immutability and a fresh release and tag before writing', async () => {
  const calls = [];
  const adapter = githubRelease(repository, (command, args) => {
    assert.equal(command, 'gh');
    calls.push(args);
    if (args.at(-1).endsWith('immutable-releases')) return '{"enabled":true}';
    return '[[]]';
  });
  await adapter.assertNewImmutableRelease('v0.1.2');
  await adapter.createDraft('v0.1.2');
  await adapter.upload('v0.1.2', ['pack.json', 'SHA256SUMS']);
  await adapter.activate('v0.1.2');
  assert.deepEqual(calls.map(args => args[0]), ['api', 'api', 'api', 'release', 'release', 'release']);
  assert.ok(calls[3].includes('--draft'));
  assert.ok(calls[5].includes('--draft=false'));
  assert.doesNotMatch(JSON.stringify(calls), /--clobber|delete|generate-notes/);
});

for (const failure of ['immutability disabled', 'existing release', 'existing tag', 'network error']) test(`GitHub adapter refuses ${failure}`, async () => {
  const adapter = githubRelease(repository, (_command, args) => {
    assert.equal(args[0], 'api', 'No mutation before verification');
    if (failure === 'network error') throw new Error('unavailable');
    if (args.at(-1).endsWith('immutable-releases')) return JSON.stringify({ enabled: failure !== 'immutability disabled' });
    if (args.at(-1).includes('/releases?') && failure === 'existing release') return '[[{"tag_name":"v0.1.2"}]]';
    if (args.at(-1).includes('/tags?') && failure === 'existing tag') return '[[{"name":"v0.1.2"}]]';
    return '[[]]';
  });
  await assert.rejects(adapter.assertNewImmutableRelease('v0.1.2'));
});

test('manifest schema rejects malformed tested Studio revision', () => {
  const pack = realPack();
  pack.tools.find(tool => tool.id === 'studio').sourceRevision = 'main';
  assert.ok(validateReleaseManifest(pack).length);
});

for (const name of ['tampered checksum', 'missing x64', 'existing output', 'invalid version', 'invalid SHA']) test(`refuses ${name}`, async t => {
  const { options, calls, release } = candidate(t);
  if (name === 'tampered checksum') writeFileSync(join(options.archivesDir, 'praxity-cli-0.3.0-macos-x64.tar.gz.sha256'), '0'.repeat(64));
  if (name === 'missing x64') options.archivesDir = join(options.archivesDir, 'absent');
  if (name === 'existing output') mkdirSync(options.outputDir);
  if (name === 'invalid version') options.version = '../bad';
  if (name === 'invalid SHA') options.studioSha = 'main';
  await assert.rejects(publishStudioPack({ ...options, dryRun: false }, release));
  assert.deepEqual(calls, []);
});

for (const failing of ['assertNewImmutableRelease', 'createDraft', 'upload']) test(`failure in ${failing} cannot activate a release`, async t => {
  const { options, calls, release } = candidate(t);
  release[failing] = async () => { throw new Error('fixture failure'); };
  await assert.rejects(publishStudioPack({ ...options, dryRun: false }, release), /fixture failure/);
  assert.equal(calls.some(call => call[0] === 'activate'), false);
});
