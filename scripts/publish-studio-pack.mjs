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

function verifyArchive(file, arch, studioSha) {
  requireValue(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Archive must be a regular file');
  const name = file.split(/[\\/]/).at(-1);
  const digest = hash(readFileSync(file));
  requireValue(readFileSync(`${file}.sha256`, 'utf8').trim() === `${digest} *${name}` ||
    readFileSync(`${file}.sha256`, 'utf8').trim() === `${digest}  ${name}`, 'Archive checksum mismatch');
  // Reuse the installer's archive parser before asking tar to read any member.
  const members = archiveInventory(file, 1);
  const files = members.filter(member => member.type !== 'D');
  requireValue(files.every(member => member.type === 'P'), 'Archive links refused');
  const allowed = /^(?:praxity\.mjs|chunk-[A-Za-z0-9_-]+\.mjs|package\.json|inventory\.json|(?:editor|export-assets|typst|node_modules|licenses|legal|prax-format)\/.+)$/;
  for (const member of files) {
    requireValue(allowed.test(member.name) && !member.name.endsWith('.map') &&
      !member.name.split('/').includes('.git') &&
      !/^(?:editor|export-assets)\/.*\.[cm]?tsx?$/.test(member.name), 'Unapproved archive member');
  }
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
    if (member.name === 'inventory.json') continue;
    requireValue(expected.get(member.name) === member.hash, 'Payload hash mismatch');
  }
  const required = ['praxity.mjs', 'package.json', 'editor/index.html', 'typst/typst', 'legal/LICENSE', 'legal/LICENSING.md'];
  for (const dependency of inventory.dependencies) {
    requireValue(dependency.notices.length > 0, 'Missing dependency notices');
    required.push(...dependency.notices);
  }
  requireValue(required.every(name => expected.has(name)), 'Missing legal, runtime or package payload');
  // Build tooling already checks its checkout path. Check common accidental
  // absolute paths again at the public boundary, including the inventory.
  const text = tar(['-xOf', file]).toString();
  requireValue(!/(?:[A-Za-z]:[\\/](?:Users|GitHub|home)[\\/]|\/(?:Users|home)\/[^/\s]+\/|studio-cli-review|build-inputs\.json)/.test(text), 'Private path or provenance in payload');
  return { digest, version: inventory.version };
}

export async function publishStudioPack({ version, studioSha, archivesDir, outputDir, repositoryRoot, dryRun = true }, release) {
  requireValue(/^\d+\.\d+\.\d+$/.test(version), 'A new stable pack version is required');
  requireValue(/^[a-f0-9]{40}$/.test(studioSha), 'A full tested Studio SHA is required');
  requireValue(!existsSync(outputDir), 'Output already exists');
  const pack = readManifest(join(repositoryRoot, 'pack.json'));
  const old = pack.version.split('.').map(Number), next = version.split('.').map(Number);
  requireValue(next.some((n, i) => n > old[i] && next.slice(0, i).every((v, j) => v === old[j])), 'Pack version must increase');
  const studio = pack.tools.find(tool => tool.id === 'studio');
  const assets = [];
  let studioVersion;
  for (const arch of ['arm64', 'x64']) {
    const names = readdirSync(archivesDir).filter(name => new RegExp(`^praxity-cli-[A-Za-z0-9.-]+-macos-${arch}\\.tar\\.gz$`).test(name));
    requireValue(names.length === 1, 'Exactly one archive per native Mac architecture is required');
    const file = join(archivesDir, names[0]);
    const verified = verifyArchive(file, arch, studioSha);
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
    const tag = `v${version}`;
    await release.assertNewImmutableRelease(tag);
    await release.createDraft(tag);
    await release.upload(tag, assets);
    await release.activate(tag);
  }
  return pack;
}

export function githubRelease(repositoryRoot, execute = execFileSync) {
  const gh = args => execute('gh', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const api = route => JSON.parse(gh(['api', '-H', 'X-GitHub-Api-Version: 2026-03-10', `repos/${repository}/${route}`]));
  return {
    async assertNewImmutableRelease(tag) {
      requireValue(api('immutable-releases').enabled === true, 'Enable Rubato release immutability first');
      // A complete paginated list distinguishes absence from authentication or network failure.
      const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]));
      requireValue(!releases.flat().some(item => item.tag_name === tag), 'Release already exists');
      const tags = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/tags?per_page=100`]));
      requireValue(!tags.flat().some(item => item.name === tag), 'Tag already exists');
    },
    async createDraft(tag) {
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
      gh(['release', 'create', tag, '--repo', repository, '--target', revision, '--draft', '--title', `Rubato ${tag}`, '--notes', 'Verified Studio CLI and pinned tool pack.']);
    },
    async upload(tag, assets) { gh(['release', 'upload', tag, '--repo', repository, ...assets]); },
    async activate(tag) { gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      version: { type: 'string' }, 'studio-sha': { type: 'string' }, archives: { type: 'string' },
      output: { type: 'string' }, publish: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
    } });
    requireValue(!(values.publish && values['dry-run']), 'Choose --publish or --dry-run');
    const repositoryRoot = resolve(import.meta.dirname, '..');
    const pack = await publishStudioPack({ version: values.version, studioSha: values['studio-sha'],
      archivesDir: resolve(values.archives), outputDir: resolve(values.output), repositoryRoot, dryRun: !values.publish }, githubRelease(repositoryRoot));
    console.log(`Pack ${pack.version}: ${values.publish ? 'published' : 'dry run verified'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
