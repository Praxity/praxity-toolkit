import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildAdapters } from '../src/skills.mjs';
import { readManifest } from '../src/manifest.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { output: { type: 'string', default: 'dist/adapters' }, installed: { type: 'string' } } });
const pack = readManifest(values.installed ? join(values.installed, 'pack.json') : join(root, 'pack.json'));
const tools = values.installed ? pack.tools.flatMap(tool => {
  const path = join(values.installed, 'tools', tool.id, tool.skillPath ?? 'skill');
  return existsSync(path) ? [path] : [];
}) : [];
const output = resolve(values.output);
if (existsSync(output)) throw new Error(`Output already exists: ${output}. Choose a fresh directory.`);
const adapters = buildAdapters({ source: join(root, 'skills'), tools, packVersion: pack.version });
for (const [host, files] of Object.entries(adapters)) for (const [name, bytes] of files) {
  const path = join(output, host, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
console.log(`Generated adapters: ${output}`);
