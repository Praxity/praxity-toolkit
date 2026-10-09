import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli } from '../src/cli.mjs';
import { validateSchema } from '../src/schema.mjs';
import { fixture } from './helpers.mjs';

const launcher = '"$HOME/.praxity/bin/praxity"';
const quiet = { print: () => {}, execute: () => { throw new Error('init must not launch a tool'); } };
const readProject = folder => JSON.parse(readFileSync(join(folder, 't3.json'), 'utf8'));
const portOf = folder => Number(new URL(readProject(folder).scripts.find(script => script.name === 'Open in Studio').previewUrl).port);
const registryFile = context => join(context.home, '.praxity/toolkit-state/t3-actions.json');
const schema = JSON.parse(readFileSync(new URL('./fixtures/t3.schema.json', import.meta.url), 'utf8'));
function course(folder, marker = 'course.yaml') {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, marker), 'course fixture\n');
  return folder;
}

test('init defaults to the current course and writes portable T3 actions', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  assert.equal(await runCli(['init'], context, quiet), 0);
  const project = readProject(context.cwd), port = portOf(context.cwd);
  assert.ok(port >= 41700 && port <= 41999);
  assert.deepEqual(project, {
    $schema: 'https://t3.codes/schema/t3.json',
    scripts: [
      { name: 'Open in Studio', command: `${launcher} studio . --port ${port} --no-open`, icon: 'play', previewUrl: `http://127.0.0.1:${port}/launch`, autoOpenPreview: true },
      { name: 'Export HTML', command: `${launcher} export . --format html --output course-html.zip`, icon: 'build' },
      { name: 'Export PDF', command: `${launcher} export . --format pdf --output course.pdf`, icon: 'build' },
      { name: 'Check accessibility', command: `${launcher} check check course-html.zip --checks accessibility`, icon: 'lint' },
      { name: 'Doctor', command: `${launcher} doctor`, icon: 'configure' },
    ],
  });
  const bytes = readFileSync(join(context.cwd, 't3.json'), 'utf8');
  assert.equal(bytes, JSON.stringify(project, null, 2) + '\n');
  assert.equal(bytes.includes(context.home), false);
  assert.equal(bytes.includes(context.cwd), false);
  assert.deepEqual(validateSchema(project, schema), []);
});

test('init merges scripts in place and preserves other keys, scripts and formatting', async t => {
  const { context } = fixture(t), file = join(context.cwd, 't3.json');
  course(context.cwd);
  const before = {
    $schema: 'https://t3.codes/schema/t3.json', iconPath: 'assets/logo.svg',
    defaultThreadEnvMode: 'worktree', worktreeSubmodules: 'none', team: { keep: true },
    scripts: [{ name: 'Custom', command: 'echo custom', async: false },
      { name: 'Export HTML', command: 'old', runOnWorktreeCreate: true },
      { name: 'Another', command: 'echo another' }, { name: 'Doctor', command: 'old doctor' }],
  };
  writeFileSync(file, JSON.stringify(before, null, 4).replaceAll('\n', '\r\n') + '\r\n');
  await runCli(['init', '.'], context, quiet);
  const after = readProject(context.cwd);
  assert.deepEqual(Object.fromEntries(Object.entries(after).filter(([key]) => key !== 'scripts')),
    Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'scripts')));
  assert.deepEqual(after.scripts[0], before.scripts[0]);
  assert.deepEqual(after.scripts[2], before.scripts[2]);
  assert.equal(after.scripts[1].name, 'Export HTML');
  assert.equal(after.scripts[1].runOnWorktreeCreate, undefined);
  assert.equal(after.scripts[3].command, `${launcher} doctor`);
  assert.equal(after.scripts.length, 7);
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(after, null, 4).replaceAll('\n', '\r\n') + '\r\n');
});

test('init is byte-idempotent and keeps the course port if t3.json is removed', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  await runCli(['init'], context, quiet);
  const file = join(context.cwd, 't3.json'), before = readFileSync(file, 'utf8');
  const state = readFileSync(registryFile(context), 'utf8'), port = portOf(context.cwd);
  await runCli(['init', context.cwd], context, quiet);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(readFileSync(registryFile(context), 'utf8'), state);
  rmSync(file);
  await runCli(['init'], context, quiet);
  assert.equal(portOf(context.cwd), port);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('init accepts .prax lessons and allocates distinct ports, including a cloned t3.json', async t => {
  const { context } = fixture(t), first = course(context.cwd, 'lesson.prax');
  const second = course(join(context.root, 'second course'), 'lesson.prax');
  await runCli(['init'], context, quiet);
  writeFileSync(join(second, 't3.json'), readFileSync(join(first, 't3.json')));
  await runCli(['init', second], context, quiet);
  assert.notEqual(portOf(first), portOf(second));
  assert.deepEqual(validateSchema(readProject(second), schema), []);
  await runCli(['init', second], context, quiet);
  assert.notEqual(portOf(first), portOf(second));
});

test('init refuses invalid JSON unchanged without creating state', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  const file = join(context.cwd, 't3.json'), bytes = '{ "scripts": [';
  writeFileSync(file, bytes);
  await assert.rejects(runCli(['init'], context, quiet), /Invalid JSON.*t3\.json/);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(existsSync(join(context.home, '.praxity')), false);
});

test('init refuses non-course folders and extra arguments without writing files', async t => {
  const { context } = fixture(t);
  await assert.rejects(runCli(['init'], context, quiet), /course\.yaml.*\.prax/);
  await assert.rejects(runCli(['init', '.', 'extra'], context, quiet), /Usage: praxity init/);
  assert.equal(existsSync(join(context.cwd, 't3.json')), false);
  assert.equal(existsSync(join(context.home, '.praxity')), false);
});

for (const bytes of ['null', '[]', '{"scripts":{}}', '{"scripts":[null]}']) {
  test(`init refuses malformed project structure ${bytes} unchanged`, async t => {
    const { context } = fixture(t);
    course(context.cwd);
    writeFileSync(join(context.cwd, 't3.json'), bytes);
    await assert.rejects(runCli(['init'], context, quiet), /Invalid t3\.json/);
    assert.equal(readFileSync(join(context.cwd, 't3.json'), 'utf8'), bytes);
    assert.equal(existsSync(join(context.home, '.praxity')), false);
  });
}

test('init refuses adding actions past T3’s 50-script limit unchanged', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  const bytes = JSON.stringify({ scripts: Array.from({ length: 46 }, (_, i) => ({ name: `Custom ${i}`, command: 'true' })) });
  writeFileSync(join(context.cwd, 't3.json'), bytes);
  await assert.rejects(runCli(['init'], context, quiet), /50 scripts/);
  assert.equal(readFileSync(join(context.cwd, 't3.json'), 'utf8'), bytes);
  assert.equal(existsSync(join(context.home, '.praxity')), false);
});

test('vendored T3 schema rejects invalid icons, long paths and too many scripts', () => {
  assert.ok(validateSchema({ scripts: [{ name: 'Bad', command: 'true', icon: 'invalid' }] }, schema).length);
  assert.ok(validateSchema({ iconPath: 'a'.repeat(513) }, schema).length);
  assert.ok(validateSchema({ scripts: Array.from({ length: 51 }, () => ({ name: 'Script', command: 'true' })) }, schema).length);
});

test('init refuses linked project files and linked private state without changing their targets', async t => {
  const { context } = fixture(t), second = course(join(context.root, 'other'));
  course(context.cwd);
  const bytes = '{"scripts":[]}';
  writeFileSync(join(second, 't3.json'), bytes);
  symlinkSync(join(second, 't3.json'), join(context.cwd, 't3.json'));
  await assert.rejects(runCli(['init'], context, quiet), /symlink refused/i);
  assert.equal(readFileSync(join(second, 't3.json'), 'utf8'), bytes);
  rmSync(join(context.cwd, 't3.json'));
  mkdirSync(join(context.home, '.praxity'));
  symlinkSync(second, join(context.home, '.praxity/toolkit-state'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(runCli(['init'], context, quiet), /symlink refused/i);
  assert.equal(existsSync(join(context.cwd, 't3.json')), false);
});

test('init restores a committed course port when the local registry is missing', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  writeFileSync(join(context.cwd, 't3.json'), JSON.stringify({ scripts: [
    { name: 'Open in Studio', command: 'praxity studio . --port 41873', previewUrl: 'http://127.0.0.1:41873/launch' },
  ] }));
  await runCli(['init'], context, quiet);
  assert.equal(portOf(context.cwd), 41873);
});

for (const command of ['praxity studio . --port 41873', `${launcher} studio . --port 41873 --no-open`]) {
  test(`init upgrades a committed ${command.startsWith('praxity') ? 'bare' : 'current'} Studio action and keeps its port`, async t => {
    const { context } = fixture(t);
    course(context.cwd);
    writeFileSync(join(context.cwd, 't3.json'), JSON.stringify({ scripts: [
      { name: 'Open in Studio', command }, { name: 'Doctor', command: 'praxity doctor' },
    ] }));
    await runCli(['init'], context, quiet);
    const scripts = readProject(context.cwd).scripts;
    assert.equal(scripts[0].command, `${launcher} studio . --port 41873 --no-open`);
    assert.equal(scripts[0].previewUrl, 'http://127.0.0.1:41873/launch');
    assert.equal(scripts[1].command, `${launcher} doctor`);
  });
}

test('init avoids another registered course’s edited Studio port as well as its reservation', async t => {
  const { context } = fixture(t), second = course(join(context.root, 'second'));
  course(context.cwd);
  await runCli(['init'], context, quiet);
  const before = readProject(context.cwd);
  before.scripts[0].command = 'praxity studio . --port 41701';
  before.scripts[0].previewUrl = 'http://127.0.0.1:41701/launch';
  writeFileSync(join(context.cwd, 't3.json'), JSON.stringify(before));
  await runCli(['init', second], context, quiet);
  assert.equal(portOf(second), 41702);
});

test('init recovers a durable reservation and dead lock before the project write', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  const registry = registryFile(context), directory = join(registry, '..');
  mkdirSync(directory, { recursive: true });
  const state = JSON.stringify({ owner: 'praxity-toolkit', schemaVersion: 1, courses: [{ folder: context.cwd, port: 41891 }] }, null, 2) + '\n';
  writeFileSync(registry, state);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  writeFileSync(join(directory, 't3-actions.lock'), JSON.stringify({ owner: 'praxity-toolkit', pid: Number(child.stdout), id: 'interrupted-init' }));
  await runCli(['init'], context, quiet);
  assert.equal(portOf(context.cwd), 41891);
  assert.equal(readFileSync(registry, 'utf8'), state);
  assert.equal(existsSync(join(directory, 't3-actions.lock')), false);
});

test('init refuses a live lock and an unowned lock without changing course or registry', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  await runCli(['init'], context, quiet);
  const registry = registryFile(context), lock = join(registry, '../t3-actions.lock');
  const state = readFileSync(registry, 'utf8'), bytes = readFileSync(join(context.cwd, 't3.json'), 'utf8');
  for (const [value, error] of [
    [{ owner: 'praxity-toolkit', pid: process.pid, id: 'active-init' }, /Another praxity init is running/],
    [{ owner: 'someone-else', pid: process.pid, id: 'user' }, /Unowned project actions lock preserved/],
  ]) {
    const lockBytes = JSON.stringify(value);
    writeFileSync(lock, lockBytes);
    await assert.rejects(runCli(['init'], context, quiet), error);
    assert.equal(readFileSync(lock, 'utf8'), lockBytes);
    assert.equal(readFileSync(registry, 'utf8'), state);
    assert.equal(readFileSync(join(context.cwd, 't3.json'), 'utf8'), bytes);
  }
});

for (const bytes of ['null', '{bad', '{"owner":"other","courses":[]}']) {
  test(`init refuses invalid private registry ${bytes} unchanged`, async t => {
    const { context } = fixture(t);
    course(context.cwd);
    const registry = registryFile(context);
    mkdirSync(join(registry, '..'), { recursive: true });
    writeFileSync(registry, bytes);
    await assert.rejects(runCli(['init'], context, quiet), /Invalid (JSON|project actions registry)/);
    assert.equal(readFileSync(registry, 'utf8'), bytes);
    assert.equal(existsSync(join(context.cwd, 't3.json')), false);
  });
}

test('init refuses an exhausted port registry without writing the course', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  const registry = registryFile(context);
  mkdirSync(join(registry, '..'), { recursive: true });
  const bytes = JSON.stringify({ owner: 'praxity-toolkit', schemaVersion: 1,
    courses: Array.from({ length: 300 }, (_, i) => ({ folder: join(context.root, `reserved ${i}`), port: 41700 + i })),
  });
  writeFileSync(registry, bytes);
  await assert.rejects(runCli(['init'], context, quiet), /No course ports available/);
  assert.equal(readFileSync(registry, 'utf8'), bytes);
  assert.equal(existsSync(join(context.cwd, 't3.json')), false);
});

test('init keeps an existing schema URL and updates each managed action once at its first position', async t => {
  const { context } = fixture(t);
  course(context.cwd);
  writeFileSync(join(context.cwd, 't3.json'), JSON.stringify({ $schema: 'custom-schema.json', scripts: [
    { name: 'Doctor', command: 'old' }, { name: 'User', command: 'echo user' }, { name: 'Doctor', command: 'duplicate' },
  ] }));
  await runCli(['init'], context, quiet);
  const project = readProject(context.cwd);
  assert.equal(project.$schema, 'custom-schema.json');
  assert.equal(project.scripts.length, 6);
  assert.deepEqual(project.scripts[0], { name: 'Doctor', command: `${launcher} doctor`, icon: 'configure' });
  assert.deepEqual(project.scripts[1], { name: 'User', command: 'echo user' });
});
