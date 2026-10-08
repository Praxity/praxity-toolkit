import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, isAbsolute, win32 } from 'node:path';
import { loadSchema, validateSchema } from './schema.mjs';

export const adapters = {
  claude: { skills: '.claude/skills', plugin: null },
  codex: { skills: '.agents/skills', plugin: null },
};
const legacyClaude = { skills: '.claude/plugins/praxity/skills', plugin: '.claude/plugins/praxity/.claude-plugin/plugin.json' };
const ownershipAdapters = [...Object.values(adapters), legacyClaude];
const canonicalHost = host => host === 't3' ? 'claude' : host;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

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
  const generate = adapter => {
    const output = new Map();
    for (const [name, files] of [...skills].sort(([a], [b]) => a.localeCompare(b))) {
      for (const [file, bytes] of files) output.set(`${adapter.skills}/${name}/${file}`, bytes);
    }
    if (adapter.plugin) output.set(adapter.plugin, Buffer.from(JSON.stringify({
      name: 'praxity', version: packVersion, description: 'Local Praxity tools for learning designers',
      author: { name: 'Praxity' },
    }, null, 2) + '\n'));
    return output;
  };
  const outputs = Object.fromEntries(Object.entries(adapters).map(([host, adapter]) => [host, generate(adapter)]));
  // Only recovery of a schema-1 transaction needs the former plugin bytes.
  // Non-enumerable so the generator never publishes a third adapter.
  Object.defineProperty(outputs, 'legacyClaude', { value: generate(legacyClaude) });
  return outputs;
}

function contained(base, name, adapterOnly = false) {
  if (typeof name !== 'string' || isAbsolute(name) || win32.isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe ownership path: ${name}`);
  if (adapterOnly && !ownershipAdapters.some(adapter => name.startsWith(`${adapter.skills}/`) || name === adapter.plugin)) throw new Error(`Unsafe ownership path: ${name}`);
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

export function installSkills(options) {
  return changeSkills({ ...options, remove: false });
}

export function uninstallSkills(options) {
  return changeSkills({ ...options, remove: true });
}

// Regenerates the adapters already recorded in this scope, so a pack upgrade
// adds and updates its skills. A scope without a record is left untouched.
export function refreshSkills({ base, outputs }) {
  if (!existsSync(contained(realpathSync(base), '.praxity/toolkit-skills.json'))) return { hosts: [], files: [] };
  return changeSkills({ base, outputs, remove: false });
}

function changeSkills({ base, otherBase, host, outputs, remove }) {
  host = host === undefined ? undefined : canonicalHost(host);
  if (host !== undefined && !Object.hasOwn(adapters, host)) throw new Error('Host must be t3, claude or codex');
  base = realpathSync(base);
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
  const errors = validateSchema(state, loadSchema('skills-ownership'));
  if (errors.length) throw new Error(`Invalid skills adapter ownership: ${errors.join('; ')}`);
  const hostsOf = record => {
    if (record.schemaVersion === 2) {
      if (new Set(record.hosts).size !== record.hosts.length) throw new Error('Invalid skills adapter set');
      for (const name of Object.keys(record.files)) if (!record.hosts.some(value => name.startsWith(`${adapters[value].skills}/`))) throw new Error('Skills files do not belong to the recorded adapters');
      return record.hosts;
    }
    if (record.host === undefined) return [];
    const adapter = record.host === 'claude' ? legacyClaude : adapters[canonicalHost(record.host)];
    if (Object.keys(record.files).some(name => !name.startsWith(`${adapter.skills}/`) && name !== adapter.plugin)) throw new Error('Skills files do not belong to the recorded adapter');
    return [canonicalHost(record.host)];
  };
  hostsOf(state);
  const validLock = record => Number.isSafeInteger(record?.pid) && record.pid > 0 && typeof record.token === 'string' && /^[a-f0-9-]{36}$/.test(record.token);
  if (state.lock && !validLock(state.lock)) throw new Error('Invalid skills lock intent');
  if (state.transaction) {
    const tx = state.transaction;
    validateFiles(tx.previous); validateFiles(tx.next?.files);
    hostsOf(tx.next);
    if (!['stage', 'remove'].includes(tx.phase) || !Array.isArray(tx.staged) || tx.staged.length !== Object.keys(tx.next.files).length || !validLock(tx.lock)) throw new Error('Invalid skills transaction');
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
  const recorded = state.lock ?? state.transaction?.lock;
  if (existsSync(lock)) {
    const names = readdirSync(lock);
    if (!recorded || names.some(name => name !== 'pid') || (existsSync(pidFile) && !JSON.stringify(recorded).startsWith(readFileSync(pidFile, 'utf8')))) throw new Error(`Unowned skills lock preserved: ${lock}`);
    if (alive(recorded.pid)) throw new Error(`Skills install locked: ${lock}`);
    if (existsSync(pidFile)) unlinkSync(pidFile); rmdirSync(lock);
  } else if (recorded && recorded.pid !== process.pid && alive(recorded.pid)) throw new Error('Skills transaction is still running');
  const lockRecord = { pid: process.pid, token: randomUUID() };
  const lockBytes = JSON.stringify(lockRecord);
  const acquire = () => {
    // The ledger retains this intent even before the lock directory or PID
    // exists, including the second acquisition after transaction recovery.
    writeState({ ...state, lock: lockRecord });
    mkdirSync(lock);
    writeFileSync(pidFile, lockBytes, { flag: 'wx', flush: true });
  };
  const release = () => {
    if (!existsSync(lock)) return;
    contained(base, '.praxity/toolkit-skills.lock/pid');
    if (readFileSync(pidFile, 'utf8') !== lockBytes || readdirSync(lock).length !== 1) throw new Error(`Skills lock changed; preserved: ${lock}`);
    unlinkSync(pidFile); rmdirSync(lock);
  };
  const checkHash = (name, allowed, absent = false, adapterOnly = true, pendingBytes) => {
    const path = contained(base, name, adapterOnly);
    if (!existsSync(path)) { if (absent) return; throw new Error(`Owned adapter changed; missing file: ${path}`); }
    if (!lstatSync(path).isFile()) throw new Error(`Owned adapter changed; preserve or move it before retrying: ${path}`);
    const bytes = readFileSync(path);
    const partial = pendingBytes && allowed.includes(digest(pendingBytes)) && bytes.length < pendingBytes.length && bytes.equals(pendingBytes.subarray(0, bytes.length));
    if (!allowed.includes(digest(bytes)) && !partial) throw new Error(`Owned adapter changed; preserve or move it before retrying: ${path}`);
  };
  const checkUnowned = ownedNames => {
    const names = [...ownedNames].filter(name => name.endsWith('/SKILL.md')).map(name => name.split('/').at(-2));
    for (const adapter of ownershipAdapters.filter(adapter => [...ownedNames].some(name => name.startsWith(`${adapter.skills}/`)))) for (const name of names) {
      const directory = contained(base, `${adapter.skills}/${name}`);
      if (existsSync(directory)) for (const file of filesIn(directory).keys()) {
        const key = relative(base, join(directory, file)).split(sep).join('/');
        if (!ownedNames.has(key)) throw new Error(`Unowned adapter file preserved during recovery: ${key}`);
      }
    }
    if ([...ownedNames].some(name => name.startsWith('.claude/plugins/praxity/'))) {
      const pluginRoot = contained(base, '.claude/plugins/praxity');
      if (existsSync(pluginRoot)) for (const file of filesIn(pluginRoot).keys()) {
        if (!ownedNames.has(`.claude/plugins/praxity/${file}`)) throw new Error(`Unowned plugin file preserved during recovery: ${file}`);
      }
    }
  };
  const finish = tx => {
    const ownedNames = new Set([...Object.keys(tx.previous), ...Object.keys(tx.next.files), ...tx.staged.map(entry => entry.temp)]);
    checkUnowned(ownedNames);
    // Validate the entire recoverable transaction before its first mutation.
    for (const name of new Set([...Object.keys(tx.previous), ...Object.keys(tx.next.files)])) {
      const allowed = [tx.previous[name], tx.next.files[name]].filter(Boolean);
      checkHash(name, allowed, tx.phase === 'remove' ? !Object.hasOwn(tx.next.files, name) : !Object.hasOwn(tx.previous, name));
    }
    const generated = tx.next.schemaVersion === 2
      ? new Map(tx.next.hosts.flatMap(value => [...outputs[value]]))
      : outputs[tx.next.host === 'claude' ? 'legacyClaude' : canonicalHost(tx.next.host)];
    for (const entry of tx.staged) checkHash(entry.temp, [tx.next.files[entry.name]], true, false, tx.phase === 'stage' ? generated.get(entry.name) : undefined);
    if (tx.phase === 'stage') {
      for (const entry of tx.staged) {
        const path = contained(base, entry.name, true), temp = contained(base, entry.temp), hash = tx.next.files[entry.name];
        if (existsSync(path) && digest(readFileSync(path)) === hash) continue;
        if (existsSync(temp) && digest(readFileSync(temp)) !== hash) {
          // Only a recorded temporary holding an exact prefix of the original
          // output is unfinished. Changed bytes and published files still fail.
          checkHash(entry.temp, [hash], false, false, generated.get(entry.name));
          unlinkSync(temp);
        }
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
    acquire();
    if (state.transaction) {
      writeState({ ...state, transaction: { ...state.transaction, lock: lockRecord } });
      finish(state.transaction);
      // Recovery completed its previous switch; acquire a new lock for this one.
      acquire();
    }
    const hosts = new Set(hostsOf(state));
    if (remove) hosts.delete(host); else if (host) hosts.add(host);
    for (const [name, hash] of Object.entries(state.files)) checkHash(name, [hash]);
    // Removing one adapter keeps the exact installed bytes of the others.
    // Legacy plugin ownership still needs the migration to current layouts.
    const desired = remove && state.schemaVersion === 2
      ? new Map(Object.keys(state.files).filter(name => [...hosts].some(value => name.startsWith(`${adapters[value].skills}/`))).map(name => [name, readFileSync(contained(base, name, true))]))
      : new Map([...hosts].sort().flatMap(value => [...outputs[value]]));
    // Distinct hosts can use distinct scopes; only visible copies compete.
    const roots = [...hosts].map(value => adapters[value].skills);
    if (hosts.has('claude')) roots.push(legacyClaude.skills);
    if (hosts.has('codex')) roots.push('.codex/skills');
    const names = new Set([...desired.keys()].filter(name => name.endsWith('/SKILL.md')).map(name => name.split('/').at(-2)));
    if (otherBase && resolve(otherBase) !== base) for (const root of roots) for (const name of names) {
      const path = contained(realpathSync(otherBase), `${root}/${name}/SKILL.md`);
      if (existsSync(path)) throw new Error(`Competing skill in the other scope: ${path}`);
    }
    for (const name of desired.keys()) {
      const path = contained(base, name, true);
      if (existsSync(path) && !Object.hasOwn(state.files, name)) throw new Error(`Unowned adapter file; refusing overwrite: ${path}`);
    }
    // Check only roots visible to the selected adapters, including legacy roots.
    for (const skillRoot of roots) {
      const root = contained(base, skillRoot);
      for (const name of names) {
        const directory = join(root, name);
        if (existsSync(directory)) for (const file of filesIn(directory).keys()) {
          const key = relative(base, join(directory, file)).split(sep).join('/');
          if (!Object.hasOwn(state.files, key)) throw new Error(`Unowned competing skill: ${directory}`);
        }
      }
    }
    const pluginRoot = join(base, '.claude/plugins/praxity');
    if ((hosts.has('claude') || Object.keys(state.files).some(name => name.startsWith('.claude/plugins/praxity/'))) && existsSync(pluginRoot)) for (const file of filesIn(pluginRoot).keys()) {
      const key = `.claude/plugins/praxity/${file}`;
      if (!Object.hasOwn(state.files, key)) throw new Error(`Unowned competing plugin file: ${join(pluginRoot, file)}`);
    }
    const hashes = Object.fromEntries([...desired].map(([name, bytes]) => [name, digest(bytes)]));
    checkUnowned(new Set([...Object.keys(state.files), ...desired.keys()]));
    const next = { owner: 'praxity-toolkit', schemaVersion: 2, hosts: [...hosts].sort(), files: hashes };
    const transaction = { phase: 'stage', previous: state.files, next, lock: lockRecord,
      staged: [...desired.keys()].map(name => ({ name, temp: `${name}.praxity-${randomUUID()}.tmp` })) };
    // Record the intended paths and hashes before creating staged adapter files.
    writeState({ ...state, transaction });
    finish(transaction);
    return { host, hosts: next.hosts, files: Object.keys(hashes) };
  } finally {
    release();
    if (!state.transaction && state.lock?.token === lockRecord.token) {
      const { lock: _lock, ...next } = state;
      writeState(next);
    }
  }
}

// Sorts each generated skill by its files in base: current, stale or missing.
// Skills the pack does not generate are ignored.
export function skillPresence({ base, host, outputs }) {
  const adapter = adapters[canonicalHost(host)], result = { current: [], stale: [], missing: [] };
  const skills = new Map();
  for (const [name, bytes] of outputs[canonicalHost(host)]) {
    const skill = name.slice(adapter.skills.length + 1).split('/')[0];
    const path = join(base, name);
    skills.set(skill, (skills.get(skill) ?? true) && existsSync(path) && readFileSync(path).equals(bytes));
  }
  for (const [skill, current] of skills) {
    result[current ? 'current' : existsSync(join(base, adapter.skills, skill, 'SKILL.md')) ? 'stale' : 'missing'].push(skill);
  }
  return result;
}
