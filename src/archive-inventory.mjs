import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function tar(archive, args) {
  const result = spawnSync('tar', args, { maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Cannot inventory archive ${archive}: ${result.stderr}`);
  return result.stdout;
}

// Hash gzip payloads in one pass. XZ payloads use BSD tar, avoiding a new
// bootstrap dependency on an xz executable. Typst's XZ archive is small.
export function archiveInventory(archive, strip) {
  const members = [];
  if (archive.endsWith('.gz')) {
    const bytes = gunzipSync(readFileSync(archive));
    const text = (start, length) => bytes.subarray(start, start + length).toString().split('\0')[0];
    let longName, longLink, local = {}, global = {};
    for (let offset = 0; offset + 512 <= bytes.length && bytes[offset] !== 0;) {
      const size = Number.parseInt(text(offset + 124, 12).trim(), 8);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error('Invalid archive size');
      const data = bytes.subarray(offset + 512, offset + 512 + size), kind = text(offset + 156, 1) || '0';
      const prefix = text(offset + 345, 155), name = text(offset, 100);
      if (kind === 'L') longName = data.toString().replace(/\0.*$/s, '');
      else if (kind === 'K') longLink = data.toString().replace(/\0.*$/s, '');
      else if (kind === 'x' || kind === 'g') {
        const attributes = {};
        for (let cursor = 0; cursor < data.length;) {
          const space = data.indexOf(32, cursor), length = Number(data.subarray(cursor, space).toString());
          if (space < cursor || !Number.isSafeInteger(length) || length <= 0 || cursor + length > data.length) throw new Error('Invalid archive attributes');
          const row = data.subarray(space + 1, cursor + length - 1).toString(), equal = row.indexOf('=');
          if (equal < 1) throw new Error('Invalid archive attribute');
          attributes[row.slice(0, equal)] = row.slice(equal + 1); cursor += length;
        }
        if (kind === 'g') global = { ...global, ...attributes }; else local = attributes;
      } else {
        const attrs = { ...global, ...local };
        if (attrs.size !== undefined && Number(attrs.size) !== size) throw new Error('Unsupported archive size override');
        members.push({ name: attrs.path ?? longName ?? (prefix ? `${prefix}/${name}` : name), kind,
          link: attrs.linkpath ?? longLink ?? text(offset + 157, 100), hash: digest(data) });
        longName = longLink = undefined; local = {};
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  } else {
    const names = tar(archive, ['-P', '-tf', archive]).toString().trimEnd().split(/\r?\n/);
    const rows = tar(archive, ['-P', '-tvf', archive]).toString().trimEnd().split(/\r?\n/);
    if (names.length !== rows.length) throw new Error('Ambiguous archive inventory');
    for (let i = 0; i < names.length; i++) {
      const row = rows[i], kind = row[0], name = names[i];
      const separator = row.indexOf(' -> '), hard = row.indexOf(' link to ') >= 0 ? ' link to ' : ' == ';
      members.push({ name, kind: kind === 'd' ? '5' : kind === 'l' ? '2' : row.includes(hard) ? '1' : kind === '-' ? '0' : kind,
        link: separator >= 0 ? row.slice(separator + 4) : row.includes(hard) ? row.slice(row.indexOf(hard) + hard.length) : '',
        hash: kind === '-' && !row.includes(hard) ? digest(tar(archive, ['-xOf', archive, name])) : undefined });
    }
  }
  const rows = new Map(), original = new Map(members.map(member => [member.name, member]));
  for (const member of members) {
    if (/^(?:\/|[A-Za-z]:)/.test(member.name) || /[\\\t\n]/.test(member.name) || member.name.split('/').includes('..')) throw new Error('Unsafe archive path');
    const name = member.name.split('/').slice(strip).filter(part => part && part !== '.').join('/');
    if (!name) continue;
    let type, hash;
    if (member.kind === '5') { type = 'D'; hash = '-'; }
    else if (member.kind === '0') { type = 'P'; hash = member.hash; }
    else if (member.kind === '2') { type = 'Q'; hash = digest(member.link); }
    else if (member.kind === '1') {
      const target = original.get(member.link);
      if (!target || target.kind !== '0') throw new Error('Unsupported archive hardlink target');
      type = 'P'; hash = target.hash;
    } else throw new Error('Unsafe archive special file');
    if (rows.has(name) && !(rows.get(name).type === 'D' && type === 'D')) throw new Error(`Duplicate archive output: ${name}`);
    rows.set(name, { name, type, hash });
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      const parent = parts.join('/');
      if (rows.has(parent) && rows.get(parent).type !== 'D') throw new Error('Archive writes through a link or file');
      rows.set(parent, { name: parent, type: 'D', hash: '-' }); parts.pop();
    }
  }
  for (const name of rows.keys()) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      if (rows.get(parts.join('/'))?.type !== 'D') throw new Error('Archive writes through a link or file');
      parts.pop();
    }
  }
  return [...rows.values()];
}
