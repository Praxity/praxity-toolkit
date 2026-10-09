import { readFileSync } from 'node:fs';
import { loadSchema, validateSchema } from './schema.mjs';

export function validateManifest(pack) {
  const errors = validateSchema(pack, loadSchema('pack'));
  if (errors.length) return errors;
  const ids = pack.tools.map(tool => tool.id);
  if (new Set(ids).size !== ids.length) errors.push('$/tools: duplicate tool id');
  if (new Set(pack.platforms).size !== pack.platforms.length) errors.push('$/platforms: duplicate platform');
  for (const tool of pack.tools) {
    for (const platform of pack.platforms) if (!tool.archives[platform]) errors.push(`$/tools/${tool.id}/archives/${platform}: required`);
  }
  for (const [id, runtime] of Object.entries(pack.runtimes)) {
    for (const platform of pack.platforms) if (!runtime.archives[platform]) errors.push(`$/runtimes/${id}/archives/${platform}: required`);
    for (const platform of pack.platforms) if (!runtime.entry[platform]) errors.push(`$/runtimes/${id}/entry/${platform}: required`);
  }
  return errors;
}

export function readManifest(file) {
  const pack = JSON.parse(readFileSync(file, 'utf8'));
  const errors = validateManifest(pack);
  if (errors.length) throw new Error(`Invalid pack manifest:\n${errors.join('\n')}`);
  return pack;
}

export function installationPlan(pack, platform) {
  if (!pack.platforms.includes(platform)) throw new Error(`Unsupported platform ${platform}`);
  const entries = Object.entries(pack.runtimes).map(([id, runtime]) => ({
    id, kind: 'runtime', entry: runtime.entry[platform], ...runtime.archives[platform],
  }));
  for (const tool of pack.tools) {
    const archive = tool.archives[platform];
    if (archive.status === 'published') entries.push({ id: tool.id, kind: 'tool', entry: tool.entry, ...archive });
  }
  return entries;
}

// The v0.1.0-rc.1 and v0.1.0-rc.2 tags shipped manifests labelled 0.1.0, so
// their packs sit in the 0.1.0 folder. Keyed by manifest SHA-256, the value is
// the name the installer moves such a folder to. The rc.1 manifest pins only
// Node and Typst; the rc.2 tag's manifest adds tool archives from the
// v0.1.0-rc.1 release. The rc.2 archives arrived in a manifest labelled
// 0.1.0-rc.2, which already has that folder name.
export const mislabeledPacks = {
  '920fbc4c99a8723221f8a0fa2f826328a4fbffbf0bfd919ad862d55a73d18b7c': { label: '0.1.0', version: '0.1.0-rc.1' },
  'ddfc9f0da049a4df0943bc23dd02d376d3f2cd4e58d636519858aa3273ea85a6': { label: '0.1.0', version: '0.1.0-rc.1' },
};
