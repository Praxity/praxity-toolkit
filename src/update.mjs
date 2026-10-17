import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveInventory } from './archive-inventory.mjs';
import { loadSchema, validateSchema } from './schema.mjs';
import { findSkillsProject } from './skills.mjs';
import { probeProcess } from './tools.mjs';

// This channel is part of the reviewed bootstrap, never a CLI or environment override.
export const officialReleaseChannel = Object.freeze({
  metadata: 'https://api.github.com/repos/Praxity/rubato/releases/latest',
  downloads: 'https://github.com/Praxity/rubato/releases/download/',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const closeInstruction = 'Save or copy all unsaved text in every Studio tab, close those tabs, then stop the Studio action in T3 or press Ctrl+C in its terminal and rerun the command.';

export function assertStudioClosed(context, run = probeProcess) {
  const result = run({ command: 'ps', args: ['-A', '-ww', '-o', 'pid=,args='], env: context.env });
  if (result.error || result.code !== 0) throw new Error(`Cannot check running Studio sessions. ${closeInstruction} ${result.error ?? result.stderr}`);
  const root = join(realpathSync(context.home), '.praxity/toolkit').replaceAll('\\', '/') + '/';
  const busy = result.stdout.split('\n').some(line => {
    const command = line.replaceAll('\\', '/');
    return command.includes(root) && (command.includes('/tools/studio/') || command.includes('/bin/praxity-studio') || /\/src\/cli\.mjs["']?\s+studio(?:\s|$)/.test(command));
  });
  // Studio cannot certify that a browser textarea is saved. Refuse instead of signalling it.
  if (busy) throw new Error(`Studio may hold unsaved text. ${closeInstruction}`);
}

function newer(version, current) {
  const left = version.split('.').map(BigInt), right = current.split('-')[0].split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return current.includes('-');
}

export async function updatePack(context, dependencies = {}) {
  const fetchRelease = dependencies.fetch ?? fetch, run = dependencies.updateProcess ?? probeProcess;
  const print = dependencies.print ?? console.log;
  assertStudioClosed(context, run);
  const download = async url => {
    const response = await fetchRelease(url, { signal: AbortSignal.timeout(30_000), headers: url === officialReleaseChannel.metadata ? { Accept: 'application/vnd.github+json' } : undefined });
    if (!response.ok) throw new Error(`Official release download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const release = JSON.parse((await download(officialReleaseChannel.metadata)).toString('utf8'));
  if (release.draft !== false || release.prerelease !== false || release.immutable !== true || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error('Invalid official stable release');
  const asset = name => {
    const matches = release.assets.filter(value => value.name === name);
    const expected = `${officialReleaseChannel.downloads}${release.tag_name}/${name}`;
    if (matches.length !== 1 || matches[0].browser_download_url !== expected) throw new Error(`Missing or non-official release asset: ${name}`);
    return expected;
  };
  const checksums = (await download(asset('SHA256SUMS'))).toString('utf8');
  const checksum = name => {
    const matches = checksums.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64}) [ *](.+)$/)).filter(row => row?.[2] === name);
    if (matches.length !== 1) throw new Error(`Missing or duplicate release checksum: ${name}`);
    return matches[0][1];
  };
  const verified = async name => {
    const expected = checksum(name), bytes = await download(asset(name));
    if (digest(bytes) !== expected) throw new Error(`Release SHA-256 mismatch: ${name}. Nothing activated.`);
    return bytes;
  };
  const manifest = await verified('pack.json');
  const scratch = mkdtempSync(join(tmpdir(), 'rubato-update-'));
  try {
    const pack = JSON.parse(manifest);
    const versionErrors = validateSchema(pack?.version, loadSchema('pack').properties.version);
    if (versionErrors.length) throw new Error(`Invalid pack manifest:\n${versionErrors.join('\n')}`);
    if (`v${pack.version}` !== release.tag_name) throw new Error('Release tag does not match its manifest');
    if (!newer(pack.version, context.pack.version)) {
      print(`Active pack ${context.pack.version} is already at or ahead of the official release.`);
      return 0;
    }
    const bootstrapName = `rubato-${pack.version}.tar.gz`;
    const bootstrapFile = join(scratch, bootstrapName);
    writeFileSync(bootstrapFile, await verified(bootstrapName));
    // Reuse the installer's archive owner; bootstrap code must contain only regular files/directories.
    const inventory = archiveInventory(bootstrapFile, 1, { allowHardlinks: false });
    if (inventory.some(entry => !['P', 'D'].includes(entry.type))) throw new Error('Unsafe release bootstrap link');
    const bootstrap = join(scratch, 'bootstrap'); mkdirSync(bootstrap);
    const extracted = run({ command: 'tar', args: ['-xf', bootstrapFile, '-C', bootstrap, '--strip-components=1'], env: context.env });
    if (extracted.error || extracted.code !== 0) throw new Error(`Release bootstrap extraction failed: ${extracted.error ?? extracted.stderr}`);
    if (!existsSync(join(bootstrap, 'pack.json')) || digest(readFileSync(join(bootstrap, 'pack.json'))) !== digest(manifest)) throw new Error('Bootstrap manifest SHA-256 mismatch');
    return installVerifiedPack(context, { bootstrap, manifest }, dependencies);
  } finally { rmSync(scratch, { recursive: true }); }
}

// The caller authenticates the bootstrap and manifest before invoking this owner.
// Local reviewed checkouts and the official updater share activation and skills.
export function installVerifiedPack(context, { bootstrap, manifest }, dependencies = {}) {
    const run = dependencies.updateProcess ?? probeProcess, print = dependencies.print ?? console.log;
    const pack = JSON.parse(manifest);
    // The verified release owns its manifest schema; the installed pack may be older.
    const errors = validateSchema(pack, JSON.parse(readFileSync(join(bootstrap, 'schemas/pack.schema.json'), 'utf8')));
    if (errors.length) throw new Error(`Invalid pack manifest:\n${errors.join('\n')}`);
    if (digest(readFileSync(join(bootstrap, 'pack.json'))) !== digest(manifest)) throw new Error('Bootstrap manifest SHA-256 mismatch');
    assertStudioClosed(context, run);
    // No timeout: interrupting the journaled installer leaves recovery to the next run.
    const installed = run({ command: 'sh', args: [join(bootstrap, 'install.sh'), '--manifest-sha256', digest(manifest), '--platform', context.state.platform], env: context.env }, { stdio: 'inherit', timeout: undefined });
    if (installed.error || installed.code === null || installed.signal) throw new Error(`Release installer interrupted. Rerun the install command to recover its journal. ${installed.error ?? installed.signal ?? ''} ${installed.stderr ?? ''}`);
    const activeFile = join(context.home, '.praxity/toolkit/active');
    if (!existsSync(activeFile) || readFileSync(activeFile, 'utf8').split('\n')[0] !== pack.version) throw new Error(`Release installer failed (${installed.code}). Nothing activated; rerun after resolving the reported error. ${installed.stderr ?? ''}`);
    if (installed.code !== 0) print(`Release installer exited ${installed.code}. ${installed.stderr ?? ''} Resolve the reported file, then run praxity skills refresh --scope user.`);
    const code = refreshInstalledSkills(context, dependencies) || installed.code;
    print(`Active pack: ${pack.version}. The next Studio launch uses this pack. Restart the agent host if its skills changed.`);
    return code;
}

// Both callers use the same project discovery and actionable refusal diagnostics.
export function refreshInstalledSkills(context, dependencies = {}, includeUser = false) {
  const run = dependencies.updateProcess ?? probeProcess, print = dependencies.print ?? console.log;
  const project = findSkillsProject(context.cwd, context.home);
  const scopes = [...(includeUser ? [{ scope: 'user', cwd: context.home }] : []), ...(project ? [{ scope: 'project', cwd: project }] : [])];
  let code = 0;
  for (const { scope, cwd } of scopes) {
    const refreshed = run({ command: 'sh', args: [join(context.home, '.praxity/bin/praxity'), 'skills', 'refresh', '--scope', scope], env: context.env }, { cwd, stdio: 'inherit', timeout: undefined });
    if (refreshed.error || refreshed.code !== 0) {
      print(`Skills were not refreshed. ${refreshed.error ?? refreshed.stderr ?? ''} Resolve the reported file, then run praxity skills refresh --scope ${scope}${scope === 'project' ? ' in this project' : ''}.`);
      code = refreshed.code || 1;
    }
  }
  return code;
}
