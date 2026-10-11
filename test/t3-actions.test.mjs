import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCli } from '../src/cli.mjs';
import { doctor } from '../src/doctor.mjs';
import { loadSchema, validateSchema } from '../src/schema.mjs';
import { fixture } from './helpers.mjs';

const repairNote = "T3 keeps a saved copy of imported actions. In T3's project Actions settings, delete each stale saved Praxity action and import it again from t3.json, or edit its saved command to match t3.json.";
const quiet = { print() {} };
const t3Items = result => result.items.filter(item => item.id.startsWith('t3.actions.'));
const probe = context => () => ({ code: 0, stdout: `v${context.pack.runtimes.node.version}`, stderr: '' });
const report = context => doctor(context, probe(context));
const directoryBytes = directory => readdirSync(directory).sort().map(name => [name, readFileSync(join(directory, name)), statSync(join(directory, name)).mtimeMs]);

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
    assert.equal(warning.fix, repairNote);
  }
  assert.equal(result.exitCode, 0);
  assert.deepEqual(validateSchema(result, loadSchema('doctor')), []);
  assert.deepEqual([file, dbFile].map(path => [readFileSync(path), statSync(path).mtimeMs]), before);
  for (const args of [['doctor'], ['doctor', '--json']]) {
    const output = [];
    assert.equal(await runCli(args, context, { doctor: report, print: text => output.push(text) }), 0);
    assert.ok(output.join('\n').includes('stale-studio'));
    assert.ok(output.join('\n').includes(repairNote));
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

for (const input of ['settings', 'project']) {
  test(`doctor stays usable with a 72 MiB optional ${input} file under a bounded heap`, async t => {
    const { context } = fixture(t);
    const paths = await projects(context, ['legacy']);
    const settingsFile = settings(context, 'legacy');
    const file = input === 'settings' ? settingsFile : join(paths.get('legacy'), 't3.json');
    const fd = openSync(file, 'w');
    try {
      writeSync(fd, '{"padding":"');
      const chunk = 'x'.repeat(1024 * 1024);
      for (let i = 0; i < 72; i++) writeSync(fd, chunk);
      writeSync(fd, '"}');
    } finally { closeSync(fd); }
    const before = statSync(file).mtimeMs;
    const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', `
      import { doctor } from ${JSON.stringify(new URL('../src/doctor.mjs', import.meta.url).href)};
      const context = ${JSON.stringify({ ...context, env: {} })};
      const result = doctor(context, () => ({ code: 0, stdout: 'v' + context.pack.runtimes.node.version, stderr: '' }));
      console.log(JSON.stringify({ exitCode: result.exitCode, platform: result.items.find(item => item.id === 'platform'), warnings: result.items.filter(item => item.id.startsWith('t3.actions.')) }));
    `], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.exitCode, 0);
    assert.equal(result.platform.status, 'ok');
    assert.deepEqual(result.warnings, []);
    assert.equal(statSync(file).mtimeMs, before);
  });
}

test('doctor accepts a 4 MiB settings file and quietly skips one byte more', async t => {
  const { context } = fixture(t);
  await projects(context, ['legacy']);
  const file = settings(context, 'legacy');
  const suffix = ',"padding":"';
  const base = readFileSync(file, 'utf8').trim().slice(0, -1) + suffix;
  const bytes = base + 'x'.repeat(4 * 1024 * 1024 - base.length - 2) + '"}';
  writeFileSync(file, bytes);
  assert.equal(t3Items(report(context)).length, 1);
  writeFileSync(file, bytes + '\n');
  assert.deepEqual(t3Items(report(context)), []);
  assert.equal(report(context).exitCode, 0);
});

test('doctor skips a mapping replaced during its private snapshot copy', async t => {
  const { context } = fixture(t);
  settings(context, 'legacy');
  await projects(context, ['legacy']);
  const database = join(context.home, '.t3/userdata/statev2.sqlite');
  const before = readFileSync(database);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const source = ${JSON.stringify(database)};
    const copy = fs.copyFileSync;
    // Mutate the fixture at the filesystem adapter, after its first real copy.
    fs.copyFileSync = (from, to, ...options) => {
      copy(from, to, ...options);
      if (from === source) { copy(source, source + '.replacement'); fs.renameSync(source + '.replacement', source); }
    };
    syncBuiltinESMExports();
    const { doctor } = await import(${JSON.stringify(new URL('../src/doctor.mjs', import.meta.url).href)});
    const context = ${JSON.stringify({ ...context, env: {} })};
    const result = doctor(context, () => ({ code: 0, stdout: 'v' + context.pack.runtimes.node.version, stderr: '' }));
    console.log(JSON.stringify({ exitCode: result.exitCode, warnings: result.items.filter(item => item.id.startsWith('t3.actions.')) }));
  `], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { exitCode: 0, warnings: [] });
  assert.deepEqual(readFileSync(database), before);
});

test('doctor skips a mapping with a rollback journal without changing its directory', async t => {
  const { context } = fixture(t);
  settings(context, 'legacy');
  await projects(context, ['legacy']);
  const directory = join(context.home, '.t3/userdata');
  writeFileSync(join(directory, 'statev2.sqlite-journal'), 'in-progress journal');
  const before = directoryBytes(directory);
  assert.deepEqual(t3Items(report(context)), []);
  assert.equal(report(context).exitCode, 0);
  assert.deepEqual(directoryBytes(directory), before);
});

for (const open of [false, true]) {
  test(`doctor leaves the whole live WAL directory unchanged with T3 ${open ? 'open' : 'closed'}`, { timeout: 15_000 }, async t => {
    let writer;
    t.after(async () => {
      if (writer && writer.exitCode === null && writer.signalCode === null) {
        const closed = once(writer, 'close');
        writer.kill();
        await closed;
      }
    });
    const { context } = fixture(t);
    settings(context, 'legacy');
    await projects(context, ['legacy']);
    const directory = join(context.home, '.t3/userdata');
    const database = join(directory, 'statev2.sqlite');
    if (open) {
      writer = spawn(process.execPath, ['--input-type=module', '-e', `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(${JSON.stringify(database)});
        db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
        const update = db.prepare('UPDATE projection_projects SET title=?');
        update.run('Committed WAL title');
        process.on('message', message => {
          if (message === 'next') update.run('Next committed WAL title');
          else if (message === 'uncommitted') { db.exec('BEGIN IMMEDIATE'); update.run('Uncommitted title'); }
          else { db.close(); process.disconnect(); return; }
          process.send('ready');
        });
        process.send('ready');
      `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      await once(writer, 'message');
    } else {
      const db = new DatabaseSync(database);
      db.exec('PRAGMA journal_mode=WAL');
      db.prepare('UPDATE projection_projects SET title=?').run('Committed WAL title');
      db.close();
    }
    try {
      const before = directoryBytes(directory);
      if (open) assert.ok(before.some(([name]) => name.endsWith('-wal')));
      else assert.ok(!before.some(([name]) => name.endsWith('-wal') || name.endsWith('-shm')));
      const warnings = t3Items(report(context));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0].message, /Committed WAL title/);
      assert.deepEqual(directoryBytes(directory), before);
      if (open) {
        const next = once(writer, 'message');
        writer.send('next');
        await next;
        const updated = directoryBytes(directory);
        assert.match(t3Items(report(context))[0].message, /Next committed WAL title/);
        assert.deepEqual(directoryBytes(directory), updated);
        // Windows locks SHM bytes during a write transaction. The committed
        // open-connection cases above compare every file on all platforms.
        if (process.platform !== 'win32') {
          const pending = once(writer, 'message');
          writer.send('uncommitted');
          await pending;
          const uncommitted = directoryBytes(directory);
          assert.match(t3Items(report(context))[0].message, /Next committed WAL title/);
          assert.deepEqual(directoryBytes(directory), uncommitted);
        }
      }
    } finally {
      if (open) {
        const closed = once(writer, 'close');
        writer.send('close');
        await closed;
        assert.equal(writer.exitCode, 0);
      }
    }
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

test('init prints the delete/re-import or edit note when actions change and leaves T3 settings alone', async t => {
  const { context } = fixture(t);
  const file = settings(context, 'legacy'), before = [readFileSync(file), statSync(file).mtimeMs];
  writeFileSync(join(context.cwd, 'course.yaml'), 'title: Fixture\n');
  writeFileSync(join(context.cwd, 't3.json'), JSON.stringify({ scripts: [{ name: 'Doctor', command: 'praxity doctor' }] }));
  const output = [];
  await runCli(['init'], context, { print: text => output.push(text) });
  assert.equal(output.at(-1), repairNote);
  assert.deepEqual([readFileSync(file), statSync(file).mtimeMs], before);
  assert.equal(existsSync(join(context.home, '.t3/userdata/statev2.sqlite')), false);
  output.length = 0;
  await runCli(['init'], context, { print: text => output.push(text) });
  assert.equal(output.length, 1);
});

test('init leaves customized actions unchanged and prints no repair note for schema or formatting changes', async t => {
  const { context } = fixture(t);
  writeFileSync(join(context.cwd, 'course.yaml'), 'title: Fixture\n');
  await runCli(['init'], context, quiet);
  const file = join(context.cwd, 't3.json'), project = JSON.parse(readFileSync(file));
  for (const action of project.scripts) {
    Object.assign(action, { command: `echo local-preflight && ${action.command}`, runOnWorktreeCreate: true, async: false, custom: { keep: true } });
  }
  delete project.$schema;
  const bytes = JSON.stringify(project);
  writeFileSync(file, bytes);
  const output = [];
  await runCli(['init'], context, { print: text => output.push(text) });
  assert.deepEqual(JSON.parse(readFileSync(file)).scripts, project.scripts);
  assert.notEqual(readFileSync(file, 'utf8'), bytes);
  assert.equal(output.length, 1);
  assert.equal(output.includes(repairNote), false);
});

test('init notes a recognized command upgrade while keeping a customized action', async t => {
  const { context } = fixture(t);
  writeFileSync(join(context.cwd, 'course.yaml'), 'title: Fixture\n');
  await runCli(['init'], context, quiet);
  const file = join(context.cwd, 't3.json'), project = JSON.parse(readFileSync(file));
  const doctor = project.scripts.find(action => action.name === 'Doctor');
  const expectedDoctor = { ...doctor };
  doctor.command = 'praxity doctor';
  const studio = project.scripts.find(action => action.name === 'Open in Studio');
  studio.command = `echo local-preflight && ${studio.command}`;
  studio.custom = { keep: true };
  writeFileSync(file, JSON.stringify(project));
  const output = [];
  await runCli(['init'], context, { print: text => output.push(text) });
  const updated = JSON.parse(readFileSync(file));
  assert.deepEqual(updated.scripts.find(action => action.name === 'Doctor'), expectedDoctor);
  assert.deepEqual(updated.scripts.find(action => action.name === 'Open in Studio'), studio);
  assert.deepEqual(output.slice(1), [repairNote]);
});

test('init notes new actions, but not a schema or formatting change with identical actions', async t => {
  const { context } = fixture(t);
  writeFileSync(join(context.cwd, 'course.yaml'), 'title: Fixture\n');
  const output = [], print = text => output.push(text);
  await runCli(['init'], context, { print });
  assert.equal(output.at(-1), repairNote);
  assert.equal(existsSync(join(context.home, '.t3')), false);
  const file = join(context.cwd, 't3.json');
  const { scripts } = JSON.parse(readFileSync(file));
  // Reordering object keys changes bytes, not action behavior.
  writeFileSync(file, JSON.stringify({ scripts: scripts.map(script => Object.fromEntries(Object.entries(script).reverse())) }));
  output.length = 0;
  await runCli(['init'], context, { print });
  assert.equal(output.length, 1);
});
