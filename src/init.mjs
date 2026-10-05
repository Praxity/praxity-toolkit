import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { loadSchema, validateSchema } from './schema.mjs';

const stateSchema = loadSchema('t3-actions-state');
const portRule = stateSchema.properties.courses.items.properties.port;
const schemaUrl = 'https://t3.codes/schema/t3.json';
const maxScripts = 50;

function actions(port) {
  return [
    { name: 'Open in Studio', command: `praxity studio . --port ${port}`, icon: 'play', previewUrl: `http://127.0.0.1:${port}/launch`, autoOpenPreview: true },
    { name: 'Export HTML', command: 'praxity export . --format html --output course-html.zip', icon: 'build' },
    { name: 'Export PDF', command: 'praxity export . --format pdf --output course.pdf', icon: 'build' },
    { name: 'Check accessibility', command: 'praxity check check course-html.zip --checks accessibility', icon: 'lint' },
    { name: 'Doctor', command: 'praxity doctor', icon: 'configure' },
  ];
}

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
  const pending = new Map(actions(port).map(script => [script.name, script]));
  const managed = new Set(pending.keys());
  const scripts = [];
  for (const script of project.scripts ?? []) {
    if (!managed.has(script.name)) scripts.push(script);
    else if (pending.has(script.name)) { scripts.push(pending.get(script.name)); pending.delete(script.name); }
  }
  scripts.push(...pending.values());
  if (scripts.length > maxScripts) throw new Error(`T3 supports at most ${maxScripts} scripts; remove an existing script before praxity init. Left unchanged.`);
  return { ...project, ...(!Object.hasOwn(project, '$schema') ? { $schema: schemaUrl } : {}), scripts };
}

function studioPort(project) {
  const script = project.scripts?.find(script => script.name === 'Open in Studio');
  const command = script?.command.match(/^praxity studio \. --port (\d+)$/);
  const preview = script?.previewUrl?.match?.(/^http:\/\/127\.0\.0\.1:(\d+)\/launch$/);
  return [...new Set([command, preview].filter(Boolean).map(match => Number(match[1])))];
}

function writeAtomic(file, bytes) {
  const temp = join(dirname(file), `.praxity-init-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', flush: true }); created = true;
    inspect(file);
    renameSync(temp, file);
  } finally {
    if (created && existsSync(temp)) unlinkSync(temp);
  }
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
    const own = state.courses.find(entry => entry.folder === folder), used = new Set();
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
      state.courses.push({ folder, port });
    }
    const merged = merge(project, port);
    const indent = bytes.match(/(?:^|\n)([ \t]+)"/)?.[1] ?? '  ';
    const newline = bytes.includes('\r\n') ? '\r\n' : '\n';
    const output = JSON.stringify(merged, null, indent).replaceAll('\n', newline) + newline;
    // Reserve first. If the project write fails or init stops, retry keeps the
    // same port; no other course can claim it in the meantime.
    const stateBytes = JSON.stringify(state, null, 2) + '\n';
    if (stateBytes !== prior.bytes) writeAtomic(registry, stateBytes);
    if (readJson(file).bytes !== bytes) throw new Error('t3.json changed during praxity init; retry to merge the new contents.');
    if (output !== bytes) writeAtomic(file, output);
    return { file, port };
  } finally { release(); }
}
