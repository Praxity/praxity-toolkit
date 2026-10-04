import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveInventory } from './archive-inventory.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function installJournal(homeArgument, rootArgument) {
  const home = realpathSync(homeArgument), root = resolve(rootArgument);
  const ledger = join(root, '.install-ledger.tsv');
  const exists = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  function contained(path, link = false) {
    path = resolve(path);
    const rel = relative(home, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Path containment refused: ${path}`);
    for (let parent = link ? dirname(path) : path; parent !== home; parent = dirname(parent)) {
      const stat = exists(parent);
      if (stat?.isSymbolicLink()) throw new Error(`Ancestor symlink refused: ${parent}`);
      if (stat) {
        const resolved = relative(home, realpathSync(parent));
        if (resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) throw new Error(`Path containment refused: ${parent}`);
      }
    }
  }
  contained(ledger);
  const lines = readFileSync(ledger, 'utf8').trimEnd().split('\n');
  if (lines.shift() !== 'praxity-toolkit-install-ledger-v1') throw new Error('Unrecognized install ledger');
  const entries = new Map();
  for (const line of lines) {
    const [type, hash, key, extra] = line.split('\t');
    if (extra !== undefined || !key || isAbsolute(key) || /^[A-Za-z]:/.test(key) || key.includes('\\') || key.split('/').some(part => !part || part === '..' || part === '.') || !['D', 'F', 'L', 'X', 'U', 'P', 'Q', 'B'].includes(type) || !(type === 'U' ? /^(?:-|[a-f0-9]{64}):[a-f0-9]{64}$/.test(hash) : /^(?:-|[a-f0-9]{64})$/.test(hash))) throw new Error('Unsafe install ledger entry');
    entries.set(key, { type, hash });
  }
  const keyFor = path => relative(home, path).split(sep).join('/');
  function inventory(path, result = [], source = false) {
    const stat = exists(path);
    if (!stat) return result;
    if (!source) contained(path, stat.isSymbolicLink());
    let type, hash;
    if (stat.isSymbolicLink()) {
      const rel = relative(home, resolve(dirname(path), readlinkSync(path)));
      if (!source && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error(`Symlink escapes containment: ${path}`);
      type = 'L'; hash = digest(readlinkSync(path));
    } else if (stat.isDirectory()) { type = 'D'; hash = '-'; }
    else if (stat.isFile()) { type = 'F'; hash = digest(readFileSync(path)); }
    else throw new Error(`Unsupported owned path: ${path}`);
    result.push({ path, type, hash, key: keyFor(path) });
    if (type === 'D') for (const name of readdirSync(path)) inventory(join(path, name), result, source);
    return result;
  }
  function append(files) {
    appendFileSync(ledger, files.map(({ type, hash, key }) => `${type}\t${hash}\t${key}\n`).join(''), { flush: true });
    for (const file of files) entries.set(file.key, file);
  }
  function check(files, complete = false) {
    for (const file of files) {
      const owned = entries.get(file.key);
      if (!owned || owned.type === 'X') throw new Error(`unowned path preserved: ${file.path}`);
      const pending = (owned.type === 'P' || owned.type === 'B') && file.type === 'F' && (!complete || owned.type === 'B' || owned.hash === file.hash)
        || owned.type === 'Q' && file.type === 'L' && owned.hash === file.hash;
      if (!pending && !(owned.type === 'U' && file.type === 'F' && owned.hash.split(':').includes(file.hash)) && (owned.type !== file.type || owned.hash !== file.hash)) throw new Error(`Installed file damaged or owned file changed: ${file.path}`);
    }
  }
  function intent(rows) {
    for (const row of rows) {
      contained(row.path, row.type === 'Q' || row.type === 'L');
      if (exists(row.path)) check(inventory(row.path));
      row.key = keyFor(row.path);
    }
    append(rows);
  }
  return {
    assert(path) { check(inventory(path)); },
    complete(path) {
      const files = inventory(path); check(files, true);
      const prefix = keyFor(path), present = new Set(files.map(file => file.key));
      for (const [key, entry] of entries) if ((key === prefix || key.startsWith(`${prefix}/`)) && ['P', 'Q'].includes(entry.type) && !present.has(key)) throw new Error(`Missing intended output: ${key}`);
      append(files);
    },
    // Legacy callers may record only already journaled writes. Never claim an
    // extra file discovered in a directory after a crash.
    record(path) { this.complete(path); },
    remove(path) {
      const files = inventory(path); check(files);
      for (const file of files.reverse()) {
        contained(file.path, file.type === 'L');
        if (file.type === 'D') rmdirSync(file.path); else unlinkSync(file.path);
        append([{ type: 'X', hash: '-', key: file.key }]);
      }
    },
    copyIntent(path, source) {
      intent(inventory(source, [], true).map(file => ({ path: join(path, relative(source, file.path)), type: file.type === 'F' ? 'P' : file.type === 'L' ? 'Q' : 'D', hash: file.hash })));
    },
    moveIntent(path, source) {
      const files = inventory(source); check(files, true);
      if (exists(path)) throw new Error(`Version destination exists: ${path}`);
      intent(files.map(file => ({ ...file, path: join(path, relative(source, file.path)) })));
    },
    archiveIntent(path, archive, strip) {
      intent([{ path, type: 'D', hash: '-' }, ...archiveInventory(archive, strip).map(row => ({ ...row, path: join(path, row.name) }))]);
    },
    write(path, bytes, options = {}) {
      intent([{ path, type: 'P', hash: digest(bytes) }]);
      writeFileSync(path, bytes, { ...options, flush: true });
      this.complete(path);
    },
    mkdir(path) {
      if (exists(path)) { check(inventory(path)); return; }
      if (!exists(dirname(path))) this.mkdir(dirname(path));
      intent([{ path, type: 'D', hash: '-' }]); mkdirSync(path);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, home, root, target, source, strip] = process.argv.slice(2);
  const journal = installJournal(home, root);
  if (operation === 'intent-copy') journal.copyIntent(target, source);
  else if (operation === 'intent-move') journal.moveIntent(target, source);
  else if (operation === 'intent-archive') journal.archiveIntent(target, source, Number(strip));
  else if (['assert', 'remove', 'record', 'complete'].includes(operation)) journal[operation](target);
  else throw new Error(`Unknown ledger operation: ${operation}`);
}
