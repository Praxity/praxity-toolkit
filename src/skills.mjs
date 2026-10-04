import { createHash, randomUUID } from 'node:crypto';
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
  const ledger = contained(base, '.praxity/toolkit-skills.json');
  contained(base, '.praxity/toolkit-skills.json.tmp');
  if (existsSync(`${ledger}.tmp`)) throw new Error(`Unowned skills metadata temporary preserved: ${ledger}.tmp`);
  mkdirSync(dirname(ledger), { recursive: true });
  let expected = existsSync(ledger) ? digest(readFileSync(ledger)) : null;
  let state = expected ? JSON.parse(readFileSync(ledger, 'utf8')) : { owner: 'praxity-toolkit', files: {} };
  const validateFiles = files => {
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Unrecognized skills ownership manifest');
    for (const [name, hash] of Object.entries(files)) {
      contained(base, name, true);
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Unsafe ownership path or hash: ${name}`);
    }
  };
  if (state.owner !== 'praxity-toolkit') throw new Error('Unrecognized skills ownership manifest');
  validateFiles(state.files);
  if (state.transaction) {
    const tx = state.transaction;
    validateFiles(tx.previous); validateFiles(tx.next?.files);
    if (!adapters[tx.next.host] || !['stage', 'remove'].includes(tx.phase) || !Array.isArray(tx.staged) || tx.staged.length !== Object.keys(tx.next.files).length || !Number.isSafeInteger(tx.lock?.pid) || tx.lock.pid <= 0 || typeof tx.lock.token !== 'string') throw new Error('Invalid skills transaction');
    const seen = new Set();
    for (const entry of tx.staged) {
      contained(base, entry.name, true); contained(base, entry.temp);
      if (seen.has(entry.name) || !Object.hasOwn(tx.next.files, entry.name) || !entry.temp.startsWith(`${entry.name}.praxity-`) || !/\.tmp$/.test(entry.temp)) throw new Error('Unsafe skills transaction path');
      seen.add(entry.name);
    }
  }
  const writeState = next => {
    contained(base, '.praxity/toolkit-skills.json');
    const actual = existsSync(ledger) ? digest(readFileSync(ledger)) : null;
    if (actual !== expected) throw new Error('Skills ledger changed during installation');
    const temp = contained(base, `.praxity/.toolkit-skills.${randomUUID()}.tmp`);
    const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    let created = false;
    try {
      writeFileSync(temp, bytes, { flag: 'wx', flush: true }); created = true;
      renameSync(temp, ledger); expected = digest(bytes); state = next;
    } finally {
      // This invocation recorded these exact bytes when it created the temp.
      if (created && existsSync(temp) && digest(readFileSync(temp)) === digest(bytes)) unlinkSync(temp);
    }
  };
  const lock = contained(base, '.praxity/toolkit-skills.lock');
  const pidFile = contained(base, '.praxity/toolkit-skills.lock/pid');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  if (existsSync(lock)) {
    const recorded = state.transaction?.lock;
    if (!recorded || !existsSync(pidFile) || readFileSync(pidFile, 'utf8') !== JSON.stringify(recorded) || readdirSync(lock).length !== 1) throw new Error(`Unowned skills lock preserved: ${lock}`);
    if (alive(recorded.pid)) throw new Error(`Skills install locked: ${lock}`);
    unlinkSync(pidFile); rmdirSync(lock);
  } else if (state.transaction && state.transaction.lock.pid !== process.pid && alive(state.transaction.lock.pid)) throw new Error('Skills transaction is still running');
  mkdirSync(lock);
  const lockRecord = { pid: process.pid, token: randomUUID() };
  const lockBytes = JSON.stringify(lockRecord);
  writeFileSync(pidFile, lockBytes, { flag: 'wx' });
  const release = () => {
    if (!existsSync(lock)) return;
    contained(base, '.praxity/toolkit-skills.lock/pid');
    if (readFileSync(pidFile, 'utf8') !== lockBytes || readdirSync(lock).length !== 1) throw new Error(`Skills lock changed; preserved: ${lock}`);
    unlinkSync(pidFile); rmdirSync(lock);
  };
  const checkHash = (name, allowed, absent = false, adapterOnly = true) => {
    const path = contained(base, name, adapterOnly);
    if (!existsSync(path)) { if (absent) return; throw new Error(`Owned adapter changed; missing file: ${path}`); }
    if (!lstatSync(path).isFile() || !allowed.includes(digest(readFileSync(path)))) throw new Error(`Owned adapter changed; preserve or move it before retrying: ${path}`);
  };
  const finish = tx => {
    const ownedNames = new Set([...Object.keys(tx.previous), ...Object.keys(tx.next.files), ...tx.staged.map(entry => entry.temp)]);
    const names = [...ownedNames].filter(name => name.endsWith('/SKILL.md')).map(name => name.split('/').at(-2));
    for (const adapter of Object.values(adapters)) for (const name of names) {
      const directory = contained(base, `${adapter.skills}/${name}`);
      if (existsSync(directory)) for (const file of filesIn(directory).keys()) {
        const key = relative(base, join(directory, file)).split(sep).join('/');
        if (!ownedNames.has(key)) throw new Error(`Unowned adapter file preserved during recovery: ${key}`);
      }
    }
    const pluginRoot = contained(base, '.claude/plugins/praxity');
    if (existsSync(pluginRoot)) for (const file of filesIn(pluginRoot).keys()) {
      if (!ownedNames.has(`.claude/plugins/praxity/${file}`)) throw new Error(`Unowned plugin file preserved during recovery: ${file}`);
    }
    // Validate the entire recoverable transaction before its first mutation.
    for (const name of new Set([...Object.keys(tx.previous), ...Object.keys(tx.next.files)])) {
      const allowed = [tx.previous[name], tx.next.files[name]].filter(Boolean);
      checkHash(name, allowed, tx.phase === 'remove' ? !Object.hasOwn(tx.next.files, name) : !Object.hasOwn(tx.previous, name));
    }
    for (const entry of tx.staged) checkHash(entry.temp, [tx.next.files[entry.name]], true, false);
    if (tx.phase === 'stage') {
      const generated = outputs[tx.next.host];
      for (const entry of tx.staged) {
        const path = contained(base, entry.name, true), temp = contained(base, entry.temp), hash = tx.next.files[entry.name];
        if (existsSync(path) && digest(readFileSync(path)) === hash) continue;
        if (!existsSync(temp)) {
          const bytes = generated.get(entry.name);
          if (!bytes || digest(bytes) !== hash) throw new Error('Interrupted skills switch needs the original adapter content');
          mkdirSync(dirname(temp), { recursive: true });
          writeFileSync(temp, bytes, { flag: 'wx', flush: true });
        }
      }
      for (const entry of tx.staged) {
        const path = contained(base, entry.name, true), temp = contained(base, entry.temp);
        if (existsSync(temp)) renameSync(temp, path);
      }
      for (const [name, hash] of Object.entries(tx.next.files)) checkHash(name, [hash]);
      tx = { ...tx, phase: 'remove', lock: lockRecord };
      // The new adapter and its ledger commit precede removal of the old one.
      writeState({ ...tx.next, transaction: tx });
    }
    for (const [name, hash] of Object.entries(tx.previous)) if (!Object.hasOwn(tx.next.files, name)) {
      const path = contained(base, name, true);
      checkHash(name, [hash], true);
      if (existsSync(path)) unlinkSync(path);
    }
    for (const entry of tx.staged) {
      const temp = contained(base, entry.temp);
      checkHash(entry.temp, [tx.next.files[entry.name]], true, false);
      if (existsSync(temp)) unlinkSync(temp);
    }
    // Keep transaction ownership until the lock is removed. A killed process
    // can then recover either the cleanup or the final ledger commit.
    release();
    writeState(tx.next);
  };
  try {
    if (state.transaction) {
      writeState({ ...state, transaction: { ...state.transaction, lock: lockRecord } });
      finish(state.transaction);
      // Recovery completed its previous switch; acquire a new lock for this one.
      mkdirSync(lock); writeFileSync(pidFile, lockBytes, { flag: 'wx' });
    }
    const desired = outputs[host];
    for (const [name, hash] of Object.entries(state.files)) checkHash(name, [hash]);
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
    const hashes = Object.fromEntries([...desired].map(([name, bytes]) => [name, digest(bytes)]));
    const next = { owner: 'praxity-toolkit', schemaVersion: 1, host, files: hashes };
    const transaction = { phase: 'stage', previous: state.files, next, lock: lockRecord,
      staged: [...desired.keys()].map(name => ({ name, temp: `${name}.praxity-${randomUUID()}.tmp` })) };
    // Record the intended paths and hashes before creating staged adapter files.
    writeState({ ...state, transaction });
    finish(transaction);
    return { host, files: Object.keys(hashes), pluginDirectory: host === 'claude' ? join(base, '.claude/plugins/praxity') : null };
  } finally { release(); }
}

export function skillPresence({ base, host, names }) {
  const adapter = adapters[host];
  const expected = names.map(name => join(base, adapter.skills, name, 'SKILL.md'));
  if (adapter.plugin) expected.push(join(base, adapter.plugin));
  return expected.every(path => existsSync(path));
}
