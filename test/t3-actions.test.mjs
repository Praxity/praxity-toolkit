import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCli } from '../src/cli.mjs';
import { doctor } from '../src/doctor.mjs';
import { loadSchema, validateSchema } from '../src/schema.mjs';
import { fixture } from './helpers.mjs';

const resetNote = "T3 keeps a saved copy of imported actions. Reset this project's actions in T3, then import the updated actions from t3.json.";
const quiet = { print() {} };
const t3Items = result => result.items.filter(item => item.id.startsWith('t3.actions.'));
const probe = context => () => ({ code: 0, stdout: `v${context.pack.runtimes.node.version}`, stderr: '' });
const report = context => doctor(context, probe(context));

function settings(context, name) {
  const folder = join(context.home, '.t3/userdata');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, 'settings.json');
  writeFileSync(file, readFileSync(new URL(`./fixtures/t3-settings-${name}.json`, import.meta.url)));
  return file;
}

async function projects(context, ids) {
  const folder = join(context.home, '.t3/userdata');
  mkdirSync(folder, { recursive: true });
  const db = new DatabaseSync(join(folder, 'statev2.sqlite'));
  try {
    db.exec('CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, deleted_at TEXT)');
    const paths = new Map();
    for (const id of ids) {
      const path = join(context.cwd, id);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'course.yaml'), 'title: Fixture\n');
      await runCli(['init', path], context, quiet);
      db.prepare('INSERT INTO projection_projects VALUES (?, ?, ?, NULL)').run(id, `Course ${id}`, path);
      paths.set(id, path);
    }
    return paths;
  } finally { db.close(); }
}

test('doctor warns once per project for canonical saved actions, without changing T3 files', async t => {
  const { context } = fixture(t);
  const file = settings(context, 'canonical');
  const paths = await projects(context, ['stale-studio', 'stale-export', 'current', 'reset', 'custom']);
  const dbFile = join(context.home, '.t3/userdata/statev2.sqlite');
  const db = new DatabaseSync(dbFile);
  db.prepare('INSERT INTO projection_projects VALUES (?, ?, ?, NULL)').run('missing-file', 'Missing file', join(context.cwd, 'missing'));
  db.close();
  const before = [file, dbFile].map(path => [readFileSync(path), statSync(path).mtimeMs]);
  const result = report(context), warnings = t3Items(result);
  assert.deepEqual(warnings.map(item => item.id).sort(), ['t3.actions.stale-export', 't3.actions.stale-studio']);
  for (const [id, action] of [['stale-studio', 'Open in Studio'], ['stale-export', 'Export PDF']]) {
    const warning = warnings.find(item => item.id === `t3.actions.${id}`);
    assert.equal(warning.status, 'partial');
    assert.ok(warning.message.includes(paths.get(id)));
    assert.ok(warning.message.includes(action));
    assert.equal(warning.fix, resetNote);
  }
  assert.equal(result.exitCode, 0);
  assert.deepEqual(validateSchema(result, loadSchema('doctor')), []);
  assert.deepEqual([file, dbFile].map(path => [readFileSync(path), statSync(path).mtimeMs]), before);
  for (const args of [['doctor'], ['doctor', '--json']]) {
    const output = [];
    assert.equal(await runCli(args, context, { doctor: report, print: text => output.push(text) }), 0);
    assert.ok(output.join('\n').includes('stale-studio'));
    assert.ok(output.join('\n').includes(resetNote));
  }
});

test('doctor compares legacy saved actions with their own project file, outside the current folder', async t => {
  const { context } = fixture(t);
  settings(context, 'legacy');
  const paths = await projects(context, ['legacy', 'reset']);
  const warnings = t3Items(report({ ...context, cwd: context.home }));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].id, 't3.actions.legacy');
  assert.ok(warnings[0].message.includes(paths.get('legacy')));
  assert.match(warnings[0].message, /Open in Studio.*Doctor/);
});

for (const [field, value] of [['previewUrl', 'http://127.0.0.1:41900/launch'], ['autoOpenPreview', false], ['runOnWorktreeCreate', true]]) {
  test(`doctor catches saved ${field} drift even when the command matches`, async t => {
    const { context } = fixture(t);
    const paths = await projects(context, ['legacy']);
    const file = settings(context, 'legacy');
    const action = JSON.parse(readFileSync(join(paths.get('legacy'), 't3.json'))).scripts[0];
    writeFileSync(file, JSON.stringify({ projectScriptOverrides: { legacy: [{ ...action, id: 'saved', [field]: value }] } }));
    assert.equal(t3Items(report(context))[0]?.id, 't3.actions.legacy');
  });
}

for (const state of ['missing', 'unreadable', 'invalid JSON', 'invalid shape']) {
  test(`doctor quietly ignores ${state} optional T3 settings`, t => {
    const { context } = fixture(t);
    const folder = join(context.home, '.t3/userdata'), file = join(folder, 'settings.json');
    if (state !== 'missing') mkdirSync(folder, { recursive: true });
    if (state === 'unreadable') mkdirSync(file);
    if (state === 'invalid JSON') writeFileSync(file, '{');
    if (state === 'invalid shape') writeFileSync(file, 'null');
    assert.deepEqual(t3Items(report(context)), []);
    assert.equal(report(context).exitCode, 0);
    if (state === 'missing') assert.equal(existsSync(folder), false);
  });
}

test('doctor does not create a missing T3 database or report deleted projects', async t => {
  const { context } = fixture(t);
  settings(context, 'legacy');
  const dbFile = join(context.home, '.t3/userdata/statev2.sqlite');
  assert.deepEqual(t3Items(report(context)), []);
  assert.equal(existsSync(dbFile), false);
  await projects(context, ['legacy']);
  const db = new DatabaseSync(dbFile);
  db.exec("UPDATE projection_projects SET deleted_at = '2026-01-01'");
  db.close();
  assert.deepEqual(t3Items(report(context)), []);
});

test('doctor quietly skips an unreadable project mapping and leaves it unchanged', t => {
  const { context } = fixture(t);
  settings(context, 'legacy');
  const file = join(context.home, '.t3/userdata/statev2.sqlite');
  writeFileSync(file, 'not a sqlite database');
  const before = [readFileSync(file), statSync(file).mtimeMs];
  assert.deepEqual(t3Items(report(context)), []);
  assert.deepEqual([readFileSync(file), statSync(file).mtimeMs], before);
});

test('an explicit empty canonical list supersedes the legacy saved list before migration', async t => {
  const { context } = fixture(t);
  await projects(context, ['legacy']);
  const file = settings(context, 'legacy'), saved = JSON.parse(readFileSync(file));
  saved.projectSettingsOverrides = { legacy: { defaultProjectScripts: [] } };
  writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(t3Items(report(context)), []);
});

test('doctor quietly skips malformed optional action data', async t => {
  const { context } = fixture(t);
  await projects(context, ['legacy']);
  const file = settings(context, 'legacy'), saved = JSON.parse(readFileSync(file));
  saved.projectScriptOverrides.legacy = [{ name: 'Open in Studio', command: 'praxity studio .', previewUrl: 123 }];
  writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(t3Items(report(context)), []);
});

test('init prints the reset/import note when actions change and leaves T3 settings alone', async t => {
  const { context } = fixture(t);
  const file = settings(context, 'legacy'), before = [readFileSync(file), statSync(file).mtimeMs];
  writeFileSync(join(context.cwd, 'course.yaml'), 'title: Fixture\n');
  writeFileSync(join(context.cwd, 't3.json'), JSON.stringify({ scripts: [{ name: 'Doctor', command: 'praxity doctor' }] }));
  const output = [];
  await runCli(['init'], context, { print: text => output.push(text) });
  assert.equal(output.at(-1), resetNote);
  assert.deepEqual([readFileSync(file), statSync(file).mtimeMs], before);
  assert.equal(existsSync(join(context.home, '.t3/userdata/statev2.sqlite')), false);
  output.length = 0;
  await runCli(['init'], context, { print: text => output.push(text) });
  assert.equal(output.length, 1);
});

test('init notes new actions, but not a schema or formatting change with identical actions', async t => {
  const { context } = fixture(t);
  writeFileSync(join(context.cwd, 'course.yaml'), 'title: Fixture\n');
  const output = [], print = text => output.push(text);
  await runCli(['init'], context, { print });
  assert.equal(output.at(-1), resetNote);
  assert.equal(existsSync(join(context.home, '.t3')), false);
  const file = join(context.cwd, 't3.json');
  const { scripts } = JSON.parse(readFileSync(file));
  // Reordering object keys changes bytes, not action behavior.
  writeFileSync(file, JSON.stringify({ scripts: scripts.map(script => Object.fromEntries(Object.entries(script).reverse())) }));
  output.length = 0;
  await runCli(['init'], context, { print });
  assert.equal(output.length, 1);
});
