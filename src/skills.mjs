import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute, win32 } from 'node:path';

export const adapters = {
  t3: { skills: '.claude/skills', plugin: null },
  codex: { skills: '.agents/skills', plugin: null },
  claude: { skills: '.claude/plugins/praxity/skills', plugin: '.claude/plugins/praxity/.claude-plugin/plugin.json' },
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const statePath = base => join(base, '.praxity', 'toolkit-skills.json');

function filesIn(directory, prefix = '') {
  const files = new Map();
  for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error(`Skill symlink refused: ${join(directory, item.name)}`);
    if (item.isDirectory()) for (const [file, bytes] of filesIn(join(directory, item.name), `${name}/`)) files.set(file, bytes);
    else if (item.isFile()) files.set(name, readFileSync(join(directory, item.name)));
    else throw new Error(`Unsupported skill file: ${name}`);
  }
  return files;
}

export function buildAdapters({ source, tools = [], packVersion }) {
  const skills = new Map();
  const collect = directory => {
    const files = filesIn(directory);
    const text = files.get('SKILL.md')?.toString();
    const frontmatter = text?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const name = frontmatter?.match(/^name:\s*["']?([a-z0-9-]+)["']?\s*$/m)?.[1];
    if (!name || !/^description:\s*\S/m.test(frontmatter)) throw new Error(`Invalid skill frontmatter: ${directory}`);
    if (skills.has(name)) throw new Error(`Duplicate skill name: ${name}`);
    skills.set(name, files);
  };
  for (const item of readdirSync(source, { withFileTypes: true })) {
    if (!item.isDirectory()) throw new Error(`Expected skill directory: ${item.name}`);
    collect(join(source, item.name));
  }
  for (const tool of tools) {
    if (existsSync(join(tool, 'SKILL.md'))) collect(tool);
    else for (const item of readdirSync(tool, { withFileTypes: true })) {
      if (item.isDirectory() && existsSync(join(tool, item.name, 'SKILL.md'))) collect(join(tool, item.name));
    }
  }
  return Object.fromEntries(Object.entries(adapters).map(([host, adapter]) => {
    const output = new Map();
    for (const [name, files] of [...skills].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [file, bytes] of files) output.set(`${adapter.skills}/${name}/${file}`, bytes);
    }
    if (adapter.plugin) output.set(adapter.plugin, Buffer.from(JSON.stringify({
      name: 'praxity', version: packVersion, description: 'Local Praxity tools for learning designers',
      author: { name: 'Praxity' },
    }, null, 2) + '\n'));
    return [host, output];
  }));
}

function contained(base, name, adapterOnly = false) {
  if (typeof name !== 'string' || isAbsolute(name) || win32.isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe ownership path: ${name}`);
  if (adapterOnly && !Object.values(adapters).some(adapter => name.startsWith(`${adapter.skills}/`) || name === adapter.plugin)) throw new Error(`Unsafe ownership path: ${name}`);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error(`Unsafe ownership path: ${name}`);
  let cursor = target;
  while (cursor !== base) {
    let stat;
    try { stat = lstatSync(cursor); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error(`Adapter symlink refused: ${cursor}`);
    if (stat) {
      const resolved = relative(base, realpathSync(cursor));
      if (resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) throw new Error(`Unsafe ownership path: ${name}`);
    }
    cursor = dirname(cursor);
  }
  return target;
}

export function installSkills({ base, otherBase, host, outputs }) {
  if (!adapters[host]) throw new Error('Host must be t3, claude or codex');
  base = realpathSync(base);
  if (otherBase && resolve(otherBase) !== base && existsSync(statePath(otherBase))) throw new Error('Toolkit skills already use the other scope. Use that scope to avoid competing copies.');
  if (otherBase && resolve(otherBase) !== base) {
    for (const files of Object.values(outputs)) for (const name of files.keys()) {
      if (name.endsWith('/SKILL.md') && existsSync(join(otherBase, name))) throw new Error(`Competing skill in the other scope: ${join(otherBase, name)}`);
    }
  }
  contained(base, '.praxity/toolkit-skills.json');
  mkdirSync(join(base, '.praxity'), { recursive: true });
  const lock = join(base, '.praxity', 'toolkit-skills.lock');
  try { mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error(`Skills install locked: ${lock}`); throw error; }
  try {
    const state = existsSync(statePath(base)) ? JSON.parse(readFileSync(statePath(base), 'utf8')) : { owner: 'praxity-toolkit', files: {} };
    if (state.owner !== 'praxity-toolkit' || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) throw new Error('Unrecognized skills ownership manifest');
    const desired = outputs[host];
    for (const [name, hash] of Object.entries(state.files)) {
      if (!Object.values(adapters).some(adapter => name.startsWith(`${adapter.skills}/`) || name === adapter.plugin) || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Unsafe ownership path or hash: ${name}`);
      const path = contained(base, name, true);
      if (!existsSync(path) || digest(readFileSync(path)) !== hash) throw new Error(`Owned adapter changed; preserve or move it before retrying: ${path}`);
    }
    for (const name of desired.keys()) {
      const path = contained(base, name, true);
      if (existsSync(path) && !Object.hasOwn(state.files, name)) throw new Error(`Unowned adapter file; refusing overwrite: ${path}`);
    }
    // Preflight every host, including disabled adapters, before writing anything.
    for (const [candidate, adapter] of Object.entries(adapters)) {
      const root = contained(base, adapter.skills);
      for (const name of new Set([...desired.keys()].filter(file => file.includes('/SKILL.md')).map(file => file.split('/').at(-2)))) {
        const directory = join(root, name);
        if (existsSync(directory)) for (const file of filesIn(directory).keys()) {
          const key = relative(base, join(directory, file)).split(sep).join('/');
          if (!Object.hasOwn(state.files, key)) throw new Error(`Unowned competing ${candidate} skill: ${directory}`);
        }
      }
    }
    const pluginRoot = join(base, '.claude/plugins/praxity');
    if (existsSync(pluginRoot)) for (const file of filesIn(pluginRoot).keys()) {
      const key = `.claude/plugins/praxity/${file}`;
      if (!Object.hasOwn(state.files, key)) throw new Error(`Unowned competing plugin file: ${join(pluginRoot, file)}`);
    }
    for (const name of state.files ? Object.keys(state.files) : []) if (!desired.has(name)) unlinkSync(contained(base, name, true));
    const hashes = {};
    for (const [name, bytes] of desired) {
      const path = contained(base, name, true);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.praxity-tmp`, bytes, { flag: 'wx' });
      renameSync(`${path}.praxity-tmp`, path);
      hashes[name] = digest(bytes);
    }
    const next = { owner: 'praxity-toolkit', schemaVersion: 1, host, files: hashes };
    writeFileSync(`${statePath(base)}.tmp`, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    renameSync(`${statePath(base)}.tmp`, statePath(base));
    return { host, files: Object.keys(hashes), pluginDirectory: host === 'claude' ? join(base, '.claude/plugins/praxity') : null };
  } finally { rmdirSync(lock); }
}

export function skillPresence({ base, host, names }) {
  const adapter = adapters[host];
  const expected = names.map(name => join(base, adapter.skills, name, 'SKILL.md'));
  if (adapter.plugin) expected.push(join(base, adapter.plugin));
  return expected.every(path => existsSync(path));
}
