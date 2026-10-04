import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const [operation, homeArgument, rootArgument, targetArgument] = process.argv.slice(2);
const home = realpathSync(homeArgument), root = resolve(rootArgument), target = resolve(targetArgument);
const ledger = join(root, '.install-ledger.tsv');
const exists = path => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function contained(path, link = false) {
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
  if (extra !== undefined || !key || isAbsolute(key) || /^[A-Za-z]:/.test(key) || key.includes('\\') || key.split('/').some(part => !part || part === '..' || part === '.') || !['D', 'F', 'L', 'X', 'U'].includes(type) || !(type === 'U' ? /^(?:-|[a-f0-9]{64}):[a-f0-9]{64}$/.test(hash) : /^(?:-|[a-f0-9]{64})$/.test(hash))) throw new Error('Unsafe install ledger entry');
  entries.set(key, { type, hash });
}
const keyFor = path => relative(home, path).split(sep).join('/');
function inventory(path, result = []) {
  const stat = exists(path);
  if (!stat) return result;
  contained(path, stat.isSymbolicLink());
  let type, hash;
  if (stat.isSymbolicLink()) {
    const rel = relative(home, realpathSync(path));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Symlink escapes containment: ${path}`);
    type = 'L'; hash = digest(readlinkSync(path));
  } else if (stat.isDirectory()) { type = 'D'; hash = '-'; }
  else if (stat.isFile()) { type = 'F'; hash = digest(readFileSync(path)); }
  else throw new Error(`Unsupported owned path: ${path}`);
  result.push({ path, type, hash, key: keyFor(path) });
  if (type === 'D') for (const name of readdirSync(path)) inventory(join(path, name), result);
  return result;
}
const files = inventory(target);
if (operation === 'record') {
  appendFileSync(ledger, files.map(({ type, hash, key }) => `${type}\t${hash}\t${key}\n`).join(''));
} else if (operation === 'assert' || operation === 'remove') {
  for (const file of files) {
    const owned = entries.get(file.key);
    if (!owned || owned.type === 'X') throw new Error(`unowned path preserved: ${file.path}`);
    if (!(owned.type === 'U' && file.type === 'F' && owned.hash.split(':').includes(file.hash)) && (owned.type !== file.type || owned.hash !== file.hash)) throw new Error(`Installed file damaged or owned file changed: ${file.path}`);
  }
  if (operation === 'remove') for (const file of files.reverse()) {
    contained(file.path, file.type === 'L');
    if (file.type === 'D') rmdirSync(file.path); else unlinkSync(file.path);
    appendFileSync(ledger, `X\t-\t${file.key}\n`);
  }
} else throw new Error(`Unknown ledger operation: ${operation}`);
