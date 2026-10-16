import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { loadSchema, validateSchema } from './schema.mjs';
import { courseActions } from './t3-actions.mjs';

const stateSchema = loadSchema('t3-actions-state');
const portRule = stateSchema.properties.courses.items.properties.port;
const schemaUrl = 'https://t3.codes/schema/t3.json';
const maxScripts = 50;
const studioCommand = /^(?:praxity|"\$HOME\/\.praxity\/bin\/praxity") studio \. --port (\d+)(?: --no-open)?$/;
const vscodeSections = Object.keys(stateSchema.$defs.vscodeSettings.properties);
const vscodeGlobs = Object.keys(stateSchema.$defs.vscodeGlobs.properties);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// T3 runs actions in a login shell that may not have ~/.praxity/bin on PATH
// yet, so actions call the launcher by its home-relative path.

function inspect(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Project actions symlink refused: ${path}`);
    return stat;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function readJson(file) {
  const stat = inspect(file);
  if (!stat) return { bytes: '', value: undefined };
  if (!stat.isFile()) throw new Error(`Expected a JSON file: ${file}`);
  const bytes = readFileSync(file, 'utf8');
  try { return { bytes, value: JSON.parse(bytes) }; }
  catch { throw new Error(`Invalid JSON in ${file}; left unchanged.`); }
}

function projectAt(folder) {
  const file = join(folder, 't3.json'), { bytes, value } = readJson(file);
  const project = value === undefined ? {} : value;
  if (!project || typeof project !== 'object' || Array.isArray(project) ||
      (Object.hasOwn(project, 'scripts') && (!Array.isArray(project.scripts) || project.scripts.some(script =>
        !script || typeof script !== 'object' || Array.isArray(script) || typeof script.name !== 'string' || typeof script.command !== 'string')))) {
    throw new Error(`Invalid t3.json structure in ${folder}; expected an object with a scripts array. Left unchanged.`);
  }
  return { file, bytes, project };
}

function merge(project, port) {
  const generated = new Map(courseActions(port).map(script => [script.name, script]));
  const pending = new Map(generated);
  const scripts = [];
  for (const script of project.scripts ?? []) {
    const action = generated.get(script.name);
    const recognized = action && (script.name === 'Open in Studio' ? studioCommand.test(script.command)
      : script.command === action.command || script.command === action.command.replace(/^"[^"]+" /, 'praxity '));
    // A familiar name alone does not make a command ours to replace.
    if (!recognized) { scripts.push(script); pending.delete(script.name); }
    else if (pending.has(script.name)) { scripts.push(pending.get(script.name)); pending.delete(script.name); }
  }
  scripts.push(...pending.values());
  if (scripts.length > maxScripts) throw new Error(`T3 supports at most ${maxScripts} scripts; remove an existing script before praxity init. Left unchanged.`);
  return { ...project, ...(!Object.hasOwn(project, '$schema') ? { $schema: schemaUrl } : {}), scripts };
}

function studioPort(project) {
  const script = project.scripts?.find(script => script.name === 'Open in Studio');
  const command = script?.command.match(studioCommand);
  const preview = script?.previewUrl?.match?.(/^http:\/\/127\.0\.0\.1:(\d+)\/launch$/);
  return [...new Set([command, preview].filter(Boolean).map(match => Number(match[1])))];
}

function writeAtomic(file, bytes, expectedBytes) {
  const temp = join(dirname(file), `.praxity-init-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', flush: true }); created = true;
    const stat = inspect(file);
    if (expectedBytes !== undefined && !isDeepStrictEqual(stat ? readFileSync(file) : null, expectedBytes)) {
      throw new Error('VS Code settings changed during praxity init; retry to merge the new contents.');
    }
    renameSync(temp, file);
  } finally {
    if (created && existsSync(temp)) unlinkSync(temp);
  }
}

function vscodeAt(folder) {
  const directory = join(folder, '.vscode'), file = join(directory, 'settings.json');
  const directoryStat = inspect(directory);
  if (directoryStat && !directoryStat.isDirectory()) throw new Error(`Expected a VS Code settings directory: ${directory}`);
  const stat = inspect(file);
  if (stat && !stat.isFile()) throw new Error(`Expected a JSON file: ${file}`);
  const bytes = stat ? readFileSync(file) : null;
  let text = '', settings;
  try {
    text = stat ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) : '';
    settings = stat ? JSON.parse(text) : {};
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error;
  }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  // Refuse rewrites that lose duplicate keys, numeric precision or key order.
  // JSONC and noncanonical value spellings also get manual instructions.
  const compact = text.replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : '');
  if (!object(settings) || (stat && compact !== JSON.stringify(settings)) ||
      vscodeSections.some(section => Object.hasOwn(settings, section) && !object(settings[section]))) settings = undefined;
  const messages = settings ? [] : [
    `${file} left unchanged; it cannot be safely rewritten. Add these entries to both files.exclude and search.exclude, preserving existing values:`,
    ...vscodeGlobs.map((key, index) => `  ${JSON.stringify(key)}: true${index < vscodeGlobs.length - 1 ? ',' : ''}`),
  ];
  return { file, bytes, settings, messages };
}

function mergeVscode(plan, entry) {
  const { settings, messages } = plan;
  const owned = entry.vscodeSettings ?? {};
  const pending = entry.pendingVscodeSettings;
  if (pending) {
    if (settings && sha256(plan.bytes ?? '') === pending.sha256) {
      for (const [section, entries] of Object.entries(pending.entries)) owned[section] = { ...owned[section], ...entries };
    } else messages.push('VS Code settings ownership is unconfirmed after an interrupted init; pending additions remain unclaimed.');
    delete entry.pendingVscodeSettings;
  }
  if (!settings) return { ...plan, output: plan.bytes };
  const retained = {}, added = {};
  for (const section of vscodeSections) {
    const entries = Object.hasOwn(settings, section) ? settings[section] : (settings[section] = {});
    for (const key of vscodeGlobs) {
      if (Object.hasOwn(entries, key)) {
        if (entries[key] === false) messages.push(`Kept ${section} ${JSON.stringify(key)}: false in ${plan.file}; author setting preserved.`);
        if (entries[key] === true && Object.hasOwn(owned[section] ?? {}, key)) (retained[section] ??= {})[key] = true;
      } else {
        entries[key] = true;
        (added[section] ??= {})[key] = true;
      }
    }
  }
  if (Object.keys(retained).length) entry.vscodeSettings = retained;
  else delete entry.vscodeSettings;
  if (!Object.keys(added).length) return { ...plan, output: plan.bytes };
  const text = plan.bytes?.toString('utf8') ?? '';
  const indent = text.match(/(?:^|\n)([ \t]+)"/)?.[1] ?? '  ';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const output = JSON.stringify(settings, null, indent).replaceAll('\n', newline) + newline;
  // Reserve additions before writing, but claim them only after their exact bytes
  // are installed. A retry can settle a killed init without adopting author keys.
  entry.pendingVscodeSettings = { sha256: sha256(output), entries: added };
  return { ...plan, output };
}

function acquireLock(file) {
  const bytes = JSON.stringify({ owner: 'praxity-toolkit', pid: process.pid, id: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    inspect(file);
    try {
      writeFileSync(file, bytes, { flag: 'wx', flush: true });
      return () => { if (readFileSync(file, 'utf8') === bytes) unlinkSync(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const prior = readJson(file).value;
    if (prior?.owner !== 'praxity-toolkit' || !Number.isInteger(prior.pid) || prior.pid <= 0 || typeof prior.id !== 'string') throw new Error(`Unowned project actions lock preserved: ${file}`);
    try { process.kill(prior.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw error;
      // A dead init cannot be writing either file. Its durable reservation is
      // reused on retry, even if it stopped before replacing t3.json.
      unlinkSync(file);
      continue;
    }
    throw new Error('Another praxity init is running. Retry when it finishes.');
  }
  throw new Error('Project actions lock changed. Retry praxity init.');
}

export function initCourse({ folder, home }) {
  const stat = inspect(folder);
  if (!stat?.isDirectory()) throw new Error(`Not a course folder: ${folder}; expected course.yaml or .prax lessons.`);
  folder = realpathSync(folder);
  const items = readdirSync(folder, { withFileTypes: true });
  if (!items.some(item => item.isFile() && (item.name === 'course.yaml' || item.name.endsWith('.prax')))) throw new Error(`Not a course folder: ${folder}; expected course.yaml or .prax lessons.`);
  const { file, bytes, project } = projectAt(folder);
  merge(project, portRule.minimum); // Preflight the script limit before creating private state.
  const vscode = vscodeAt(folder);
  home = realpathSync(home);
  const directory = join(home, '.praxity/toolkit-state'), registry = join(directory, 't3-actions.json');
  const lock = join(directory, 't3-actions.lock');
  for (const path of [join(home, '.praxity'), directory, registry, lock]) inspect(path);
  const prior = readJson(registry);
  const state = prior.value === undefined ? { owner: 'praxity-toolkit', schemaVersion: 1, courses: [] } : prior.value;
  if (validateSchema(state, stateSchema).length || state.courses.some(entry => !isAbsolute(entry.folder)) ||
      new Set(state.courses.map(entry => entry.folder)).size !== state.courses.length ||
      new Set(state.courses.map(entry => entry.port)).size !== state.courses.length) throw new Error(`Invalid project actions registry: ${registry}; left unchanged.`);
  mkdirSync(directory, { recursive: true });
  const release = acquireLock(lock);
  try {
    // Read again after taking the lock, so another init's reservation is visible.
    if (readJson(registry).bytes !== prior.bytes) throw new Error('Project actions registry changed. Retry praxity init.');
    let own = state.courses.find(entry => entry.folder === folder);
    const used = new Set();
    for (const entry of state.courses) {
      if (entry === own) continue;
      used.add(entry.port);
      if (existsSync(entry.folder)) for (const port of studioPort(projectAt(entry.folder).project)) used.add(port);
    }
    let port = own?.port;
    if (port && used.has(port)) throw new Error(`Studio port ${port} is also used by another initialized course. Fix its t3.json before retrying.`);
    if (!port) {
      const saved = studioPort(project);
      port = saved.length === 1 && saved[0] >= portRule.minimum && saved[0] <= portRule.maximum && !used.has(saved[0]) ? saved[0] : undefined;
      for (let candidate = portRule.minimum; !port && candidate <= portRule.maximum; candidate++) if (!used.has(candidate)) port = candidate;
      if (!port || state.courses.length >= stateSchema.properties.courses.maxItems) throw new Error(`No course ports available in ${portRule.minimum}-${portRule.maximum}.`);
      own = { folder, port };
      state.courses.push(own);
    }
    const merged = merge(project, port);
    const indent = bytes.match(/(?:^|\n)([ \t]+)"/)?.[1] ?? '  ';
    const newline = bytes.includes('\r\n') ? '\r\n' : '\n';
    const output = JSON.stringify(merged, null, indent).replaceAll('\n', newline) + newline;
    const settings = mergeVscode(vscode, own);
    // Reserve first. If the project write fails or init stops, retry keeps the
    // same port; no other course can claim it in the meantime.
    const stateBytes = JSON.stringify(state, null, 2) + '\n';
    if (stateBytes !== prior.bytes) writeAtomic(registry, stateBytes);
    if (readJson(file).bytes !== bytes) throw new Error('t3.json changed during praxity init; retry to merge the new contents.');
    if (output !== bytes) writeAtomic(file, output);
    if (settings.output !== settings.bytes) {
      mkdirSync(dirname(settings.file), { recursive: true });
      writeAtomic(settings.file, settings.output, settings.bytes);
      mergeVscode(vscodeAt(folder), own);
      writeAtomic(registry, JSON.stringify(state, null, 2) + '\n');
    }
    return { file, port, actionsChanged: !isDeepStrictEqual(project.scripts ?? [], merged.scripts), messages: settings.messages };
  } finally { release(); }
}
