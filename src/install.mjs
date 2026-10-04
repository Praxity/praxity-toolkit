import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, lstatSync, statSync, readdirSync, realpathSync, readlinkSync, mkdirSync } from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { readManifest, installationPlan } from './manifest.mjs';
import { buildAdapters } from './skills.mjs';
import { quotePosix } from './tools.mjs';

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function inspectTree(root, directory = root) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = relative(root, realpathSync(path));
      if (target === '..' || target.startsWith(`..${sep}`) || isAbsolute(target)) throw new Error(`Archive symlink escapes artifact: ${path}`);
    } else if (stat.isDirectory()) inspectTree(root, path);
    else if (!stat.isFile()) throw new Error(`Archive contains special file: ${path}`);
  }
}

const [command, manifestFile, platform, stage] = process.argv.slice(2);
const pack = readManifest(manifestFile);
const plan = installationPlan(pack, platform);
if (command === 'plan') {
  if (platform !== 'darwin-arm64') throw new Error('Only darwin-arm64 installation is implemented');
  for (const entry of plan) {
    if (!entry.entry || entry.format === 'zip') throw new Error(`Unsupported archive layout: ${entry.id}`);
    console.log([entry.kind, entry.id, entry.url, entry.sha256, entry.format, entry.stripComponents, entry.entry].join('\t'));
  }
} else if (command === 'finalize') {
  const files = {};
  const links = {};
  const collect = (directory, prefix = '') => {
    for (const name of readdirSync(directory)) {
      if (!prefix && ['state.json', '.praxity-install', '.manifest-sha256'].includes(name)) continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) collect(path, `${prefix}${name}/`);
      else if (stat.isFile()) files[`${prefix}${name}`] = hash(path);
      else if (stat.isSymbolicLink()) links[`${prefix}${name}`] = readlinkSync(path);
    }
  };
  for (const entry of plan) {
    const directory = join(stage, entry.kind === 'runtime' ? 'runtimes' : 'tools', entry.id);
    inspectTree(directory);
    if (!existsSync(join(directory, entry.entry)) || !statSync(join(directory, entry.entry)).isFile()) throw new Error(`Missing executable entry file for ${entry.id}`);
    const definition = entry.kind === 'runtime' ? pack.runtimes[entry.id] : pack.tools.find(tool => tool.id === entry.id);
    if (!existsSync(join(directory, definition.notices)) || !statSync(join(directory, definition.notices)).isFile()) throw new Error(`Missing notices for ${entry.id}: ${definition.notices}`);
    if (entry.kind === 'tool' && definition.skillPath && !existsSync(join(directory, definition.skillPath))) throw new Error(`Missing skill for ${entry.id}: ${definition.skillPath}`);
  }
  buildAdapters({ source: join(stage, 'skills'), packVersion: pack.version,
    tools: pack.tools.filter(tool => tool.skillPath && plan.some(entry => entry.kind === 'tool' && entry.id === tool.id)).map(tool => join(stage, 'tools', tool.id, tool.skillPath)) });
  mkdirSync(join(stage, 'bin'), { recursive: true });
  // Tool wrappers resolve relative to their pack, so staged paths never leak
  // into launchers and the shared Node also serves Check's compiled entry.
  for (const tool of pack.tools.filter(tool => plan.some(entry => entry.kind === 'tool' && entry.id === tool.id))) {
    const nodeEntry = pack.runtimes.node.entry[platform];
    const call = `${tool.runner === 'node' ? `"${'$'}PACK_DIR/runtimes/node/${nodeEntry}" ` : ''}"${'$'}PACK_DIR/tools/${tool.id}/${tool.entry}"`;
    const body = `#!/bin/sh\nset -eu\nPACK_DIR=$(CDPATH= cd -- "${'$'}{0%/*}/.." && pwd)\nexec ${call} "${'$'}@"\n`;
    writeFileSync(join(stage, 'bin', `praxity-${tool.id}`), body, { mode: 0o755 });
  }
  const base = process.argv[6];
  const wrapper = `#!/bin/sh\n# Praxity toolkit launcher\nset -eu\nROOT=${quotePosix(base)}\nVERSION=$(sed -n '1p' "${'$'}ROOT/active")\ncase "${'$'}VERSION" in *[!a-zA-Z0-9.-]*|.*|'') echo 'Invalid current pack' >&2; exit 1;; esac\nexec "${'$'}ROOT/${'$'}VERSION/runtimes/node/${pack.runtimes.node.entry[platform]}" "${'$'}ROOT/${'$'}VERSION/src/cli.mjs" "${'$'}@"\n`;
  writeFileSync(join(stage, 'launcher.sh'), wrapper, { mode: 0o755 });
  collect(stage);
  writeFileSync(join(stage, 'state.json'), JSON.stringify({ owner: 'praxity-toolkit', schemaVersion: 1, platform,
    manifestSha256: hash(manifestFile), installed: plan.filter(entry => entry.kind === 'tool').map(entry => entry.id),
    launcherSha256: hash(join(stage, 'launcher.sh')), files, links }, null, 2) + '\n');
  writeFileSync(join(stage, '.praxity-install'), 'praxity-toolkit\n');
} else if (command === 'verify') {
  const state = JSON.parse(readFileSync(join(stage, 'state.json'), 'utf8'));
  if (state.owner !== 'praxity-toolkit' || state.manifestSha256 !== hash(manifestFile)) throw new Error('Pack version already exists with a different manifest');
  inspectTree(stage);
  for (const [file, expected] of Object.entries(state.files)) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Unsafe installed inventory path');
    if (!existsSync(join(stage, file)) || !lstatSync(join(stage, file)).isFile() || hash(join(stage, file)) !== expected) throw new Error(`Installed file damaged: ${file}. Roll back or move this pack aside before reinstalling.`);
  }
  for (const [file, expected] of Object.entries(state.links ?? {})) {
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..') || !lstatSync(join(stage, file)).isSymbolicLink() || readlinkSync(join(stage, file)) !== expected) throw new Error(`Installed link damaged: ${file}`);
  }
} else throw new Error(`Unknown install operation: ${command}`);
