import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { archiveInventory } from '../src/archive-inventory.mjs';
import { readManifest, validateReleaseManifest } from '../src/manifest.mjs';

const repository = 'Praxity/rubato';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const tar = args => execFileSync('tar', args, { maxBuffer: 512 * 1024 * 1024 });
const newer = (version, previous) => {
  const next = version.split('.').map(BigInt), old = previous.split('.').map(BigInt);
  return next.some((n, i) => n > old[i] && next.slice(0, i).every((v, j) => v === old[j]));
};

export function verifyStudioArchive(file, arch, studioSha, expectedDigest, studio) {
  requireValue(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Archive must be a regular file');
  const name = file.split(/[\\/]/).at(-1);
  const digest = hash(readFileSync(file));
  requireValue(/^[a-f0-9]{64}$/.test(expectedDigest), 'Expected build digest is required');
  requireValue(digest === expectedDigest, 'Build archive digest mismatch');
  requireValue(readFileSync(`${file}.sha256`, 'utf8').trim() === `${digest} *${name}` ||
    readFileSync(`${file}.sha256`, 'utf8').trim() === `${digest}  ${name}`, 'Archive checksum mismatch');
  // Reuse the installer's archive parser before asking tar to read any member.
  const members = archiveInventory(file, 1);
  const files = members.filter(member => member.type !== 'D');
  requireValue(files.every(member => member.type === 'P'), 'Archive links refused');
  // Candidate archives have one fixed root. Reject alternate roots and aliases.
  const rawNames = tar(['-tf', file]).toString().trim().split(/\r?\n/);
  requireValue(rawNames.every(name => name === 'studio-cli/' || name.startsWith('studio-cli/')), 'Unexpected archive root');
  const inventory = JSON.parse(tar(['-xOf', file, 'studio-cli/inventory.json']));
  requireValue(inventory.sourceRevision === studioSha && inventory.sourceTreeDirty === false, 'Untested or dirty Studio revision');
  requireValue(inventory.platform === 'darwin' && inventory.arch === arch, 'Wrong native architecture');
  requireValue(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(inventory.version), 'Invalid Studio version');
  requireValue(inventory.entrypoint === 'praxity.mjs', 'Unexpected Studio entrypoint');
  requireValue(hash(JSON.stringify(inventory.files)) === inventory.payloadSha256, 'Invalid payload inventory');
  const expected = new Map(inventory.files.map(entry => [entry.path, entry.sha256]));
  requireValue(expected.size === inventory.files.length, 'Duplicate inventory member');
  requireValue(files.length === expected.size + 1, 'Inventory does not cover archive');
  for (const member of files) {
    // The build inventory owns chunk names. Limit it to public payload families.
    requireValue((member.name === 'inventory.json' || expected.has(member.name)) &&
      /^(?:[^/]+\.mjs|package\.json|inventory\.json|(?:editor|export-assets|typst|node_modules|licenses|legal|prax-format)\/.+)$/.test(member.name) &&
      !member.name.endsWith('.map') && !member.name.split('/').includes('.git') &&
      !/^(?:editor|export-assets)\/.*\.[cm]?tsx?$/.test(member.name), 'Unapproved archive member');
    if (member.name === 'inventory.json') continue;
    requireValue(expected.get(member.name) === member.hash, 'Payload hash mismatch');
  }
  const required = [studio.entry, studio.notices, 'package.json', 'editor/index.html', 'typst/typst', 'legal/LICENSE', 'legal/LICENSING.md'];
  if (studio.skillPath) required.push(`${studio.skillPath}/SKILL.md`);
  for (const dependency of inventory.dependencies) {
    requireValue(dependency.notices.length > 0, 'Missing dependency notices');
    required.push(...dependency.notices);
  }
  requireValue(required.every(name => expected.has(name)), 'Missing legal, runtime or package payload');
  // Upstream paths are allowed only in these vendored families, with third-party
  // provenance in the verified inventory. Scan all Praxity payload and inventory.
  const upstream = /^(?:typst|node_modules|licenses)\/|^export-assets\/image-codecs\//;
  const scanned = ['inventory.json', ...inventory.files
    .filter(entry => !(entry.component === 'third-party' && upstream.test(entry.path)))
    .map(entry => entry.path)];
  const text = tar(['-xOf', file, ...scanned.map(name => `studio-cli/${name}`)]).toString();
  requireValue(!/(?:[A-Za-z]:[\\/](?:Users|GitHub|home)[\\/]|\/(?:Users|home)\/[^/\s]+\/|\/Volumes\/|\/private\/var\/folders\/|\/opt\/|studio-cli-review|build-inputs\.json)/.test(text), 'Private path or provenance in payload');
  return { digest, version: inventory.version };
}

export async function publishStudioPack({ version, studioSha, archivesDir, outputDir, repositoryRoot, expectedDigests, dryRun = true }, release) {
  requireValue(/^\d+\.\d+\.\d+$/.test(version), 'A new stable pack version is required');
  requireValue(/^[a-f0-9]{40}$/.test(studioSha), 'A full tested Studio SHA is required');
  requireValue(!existsSync(outputDir), 'Output already exists');
  const pack = readManifest(join(repositoryRoot, 'pack.json'));
  requireValue(newer(version, pack.version), 'Pack version must increase');
  const studio = pack.tools.find(tool => tool.id === 'studio');
  const assets = [];
  let studioVersion;
  for (const arch of ['arm64', 'x64']) {
    const names = readdirSync(archivesDir).filter(name => new RegExp(`^praxity-cli-[A-Za-z0-9.-]+-macos-${arch}\\.tar\\.gz$`).test(name));
    requireValue(names.length === 1, 'Exactly one archive per native Mac architecture is required');
    const file = join(archivesDir, names[0]);
    const verified = verifyStudioArchive(file, arch, studioSha, expectedDigests?.[arch], studio);
    requireValue(!studioVersion || studioVersion === verified.version, 'Studio archive versions differ');
    studioVersion = verified.version;
    studio.archives[`darwin-${arch}`] = { status: 'published',
      url: `https://github.com/${repository}/releases/download/v${version}/${names[0]}`,
      sha256: verified.digest, format: 'tar.gz', stripComponents: 1 };
    assets.push(file);
  }
  pack.version = version;
  studio.version = `${studioVersion.split('-')[0]}-main.${studioSha.slice(0, 8)}`;
  studio.sourceRevision = studioSha;
  // Keep historical releases untouched; new manifests use the current repository.
  for (const tool of pack.tools) for (const archive of Object.values(tool.archives)) {
    if (archive.status === 'published') archive.url = archive.url.replace('https://github.com/Praxity/praxity-toolkit/', 'https://github.com/Praxity/rubato/');
  }
  const errors = validateReleaseManifest(pack);
  requireValue(errors.length === 0, `Invalid release manifest: ${errors.join('; ')}`);
  const tag = `v${version}`;
  await release.assertNewImmutableRelease(tag);
  mkdirSync(outputDir);
  const staging = join(outputDir, 'bootstrap');
  mkdirSync(staging);
  try {
    // Only the public install payload is exported. Never archive a working tree.
    const archive = execFileSync('git', ['archive', '--format=tar', '--prefix=rubato/', 'HEAD',
      'install.sh', 'LICENSE', 'package.json', 'src', 'scripts', 'schemas', 'skills', 'fixtures'],
    { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', staging], { input: archive });
    const manifest = `${JSON.stringify(pack, null, 2)}\n`;
    writeFileSync(join(outputDir, 'pack.json'), manifest, { flag: 'wx' });
    writeFileSync(join(staging, 'rubato/pack.json'), manifest);
    const pkgFile = join(staging, 'rubato/package.json');
    const pkg = JSON.parse(readFileSync(pkgFile));
    writeFileSync(pkgFile, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
    const bootstrap = join(outputDir, `rubato-${version}.tar.gz`);
    tar(['-czf', bootstrap, '-C', staging, 'rubato']);
    assets.push(join(outputDir, 'pack.json'), bootstrap);
    const checksums = join(outputDir, 'SHA256SUMS');
    writeFileSync(checksums, assets.map(file => `${hash(readFileSync(file))}  ${file.split(/[\\/]/).at(-1)}\n`).join(''), { flag: 'wx' });
    assets.push(checksums);
  } finally {
    rmSync(staging, { recursive: true });
  }
  if (!dryRun) {
    const expected = assets.map((file, i) => ({ name: file.split(/[\\/]/).at(-1), digest: i < 2 ? expectedDigests[['arm64', 'x64'][i]] : hash(readFileSync(file)) }));
    const id = await release.createDraft(tag);
    await release.upload(id, assets);
    await release.verifyDraft(id, expected);
    await release.activate(id);
    await release.verifyPublished(id, expected);
  }
  return pack;
}

export function githubRelease(repositoryRoot, execute = execFileSync) {
  const gh = args => execute('gh', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const api = route => JSON.parse(gh(['api', '-H', 'X-GitHub-Api-Version: 2026-03-10', `repos/${repository}/${route}`]));
  const listedAssets = id => JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/releases/${id}/assets?per_page=100`])).flat();
  const verifyAssets = (assets, expected) => {
    requireValue(assets.length === expected.length && new Set(assets.map(asset => asset.name)).size === expected.length, 'Release asset set mismatch');
    for (const item of expected) requireValue(assets.some(asset => asset.name === item.name && asset.digest === `sha256:${item.digest}`), `Release asset digest mismatch: ${item.name}`);
  };
  const assertLatest = version => {
    const latest = api('releases/latest').tag_name;
    requireValue(/^v\d+\.\d+\.\d+$/.test(latest) && newer(version, latest.slice(1)), 'Pack version must be greater than Latest');
  };
  let admittedTag;
  return {
    async assertNewImmutableRelease(tag) {
      requireValue(api('immutable-releases').enabled === true, 'Enable Rubato release immutability first');
      // A complete paginated list distinguishes absence from authentication or network failure.
      const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]));
      requireValue(!releases.flat().some(item => item.tag_name === tag), 'Release already exists');
      for (const item of releases.flat().filter(item => !item.draft && /^v\d+\.\d+\.\d+$/.test(item.tag_name))) {
        requireValue(newer(tag.slice(1), item.tag_name.slice(1)), 'Pack version must be greater than every published stable release');
      }
      // Rubato already has a stable release. A failed Latest read must refuse.
      assertLatest(tag.slice(1));
      const tags = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/tags?per_page=100`]));
      requireValue(!tags.flat().some(item => item.name === tag), 'Tag already exists');
      admittedTag = tag;
    },
    async createDraft(tag) {
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
      requireValue(tag === admittedTag, 'Release was not admitted');
      const result = JSON.parse(gh(['api', '--method', 'POST', `repos/${repository}/releases`, '-f', `tag_name=${tag}`, '-f', `target_commitish=${revision}`, '-F', 'draft=true', '-f', `name=Rubato ${tag}`, '-f', 'body=Verified Studio CLI and pinned tool pack.']));
      requireValue(Number.isSafeInteger(result.id) && result.id > 0, 'Invalid draft release ID');
      return result.id;
    },
    async upload(id, assets) {
      for (const file of assets) gh(['api', '--method', 'POST', `https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(file.split(/[\\/]/).at(-1))}`, '-H', 'Content-Type: application/octet-stream', '--input', file]);
    },
    async verifyDraft(id, expected) {
      requireValue(api(`releases/${id}`).draft === true, 'Expected inactive draft release');
      const assets = listedAssets(id);
      verifyAssets(assets, expected);
      for (const asset of assets) {
        requireValue(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid release asset ID');
        const bytes = execute('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${asset.id}`], { cwd: repositoryRoot, maxBuffer: 512 * 1024 * 1024 });
        requireValue(hash(bytes) === expected.find(item => item.name === asset.name).digest, `Draft asset bytes mismatch: ${asset.name}`);
      }
    },
    async activate(id) {
      const draft = api(`releases/${id}`);
      requireValue(draft.draft === true && draft.tag_name === admittedTag, 'Unexpected draft release');
      assertLatest(admittedTag.slice(1));
      gh(['api', '--method', 'PATCH', `repos/${repository}/releases/${id}`, '-F', 'draft=false', '-f', 'make_latest=true']);
    },
    async verifyPublished(id, expected) {
      const live = api(`releases/${id}`);
      requireValue(live.draft === false && live.immutable === true, 'Published release is not immutable');
      verifyAssets(listedAssets(id), expected);
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      version: { type: 'string' }, 'studio-sha': { type: 'string' }, archives: { type: 'string' },
      output: { type: 'string' }, publish: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
      'expect-arm64-sha256': { type: 'string' }, 'expect-x64-sha256': { type: 'string' },
    } });
    requireValue(!(values.publish && values['dry-run']), 'Choose --publish or --dry-run');
    const repositoryRoot = resolve(import.meta.dirname, '..');
    const pack = await publishStudioPack({ version: values.version, studioSha: values['studio-sha'],
      expectedDigests: { arm64: values['expect-arm64-sha256'], x64: values['expect-x64-sha256'] },
      archivesDir: resolve(values.archives), outputDir: resolve(values.output), repositoryRoot, dryRun: !values.publish }, githubRelease(repositoryRoot));
    console.log(`Pack ${pack.version}: ${values.publish ? 'published' : 'dry run verified'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
