import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli } from '../src/cli.mjs';
import { loadSchema, validateSchema } from '../src/schema.mjs';
import { fixture } from './helpers.mjs';

// Literal expectations come from the init contract, independently of the writer.
const exclusions = { '**/.praxity-write-*': true, '**/.praxity-transaction.json': true, '**/.praxity': true };
const expected = { 'files.exclude': exclusions, 'search.exclude': exclusions };
const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
function setup(t, bytes) {
  const { context } = fixture(t), messages = [];
  writeFileSync(join(context.cwd, 'course.yaml'), 'course fixture\n');
  const file = join(context.cwd, '.vscode/settings.json');
  if (bytes !== undefined) {
    mkdirSync(join(context.cwd, '.vscode'));
    writeFileSync(file, bytes);
  }
  const registry = join(context.home, '.praxity/toolkit-state/t3-actions.json');
  const init = () => runCli(['init'], context, { print: message => messages.push(message) });
  return { context, file, registry, init, messages };
}

function interruptedInit(context, mode) {
  // Interrupt the real filesystem adapter at its durable rename boundary.
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const cwd = ${JSON.stringify(context.cwd)}, home = ${JSON.stringify(context.home)};
    const mode = ${JSON.stringify(mode)}, rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      const path = String(to).replaceAll('\\\\', '/');
      if (path.endsWith('/t3-actions.json') && mode === 'before') process.exit(91);
      if (path.endsWith('/settings.json') && mode === 'after') process.exit(91);
      if (path.endsWith('/t3-actions.json') && mode === 'changed') {
        fs.writeFileSync(cwd + '/.vscode/settings.json', '{"author":true}\\n');
      }
    };
    syncBuiltinESMExports();
    const { runCli } = await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)});
    try { await runCli(['init'], { cwd, home }, { print: () => {} }); }
    catch (error) { console.error(error.message); process.exitCode = 92; }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

function inventory(folder) {
  return Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => [join(entry.parentPath, entry.name).slice(folder.length + 1).replaceAll('\\', '/'),
      readFileSync(join(entry.parentPath, entry.name))]));
}

test('init changes only settings and T3 actions in the project', async t => {
  const { context, init } = setup(t, '{"editor.fontSize":16}\n');
  writeFileSync(join(context.cwd, '.vscode/tasks.json'), '{"version":"2.0.0","tasks":[{"label":"author task"}]}\n');
  writeFileSync(join(context.cwd, 't3.json'), '{"author":true}\n');
  const before = inventory(context.cwd);
  await init();
  const after = inventory(context.cwd);
  for (const file of ['.vscode/settings.json', 't3.json']) {
    assert.ok(Object.hasOwn(after, file));
    delete before[file];
    delete after[file];
  }
  assert.deepEqual(after, before);
});

test('init hides recovery files and identity in both VS Code views, without changing Git ignores', async t => {
  const { context, file, registry, init } = setup(t);
  const ignore = join(context.cwd, '.gitignore'), gitExclude = join(context.cwd, '.git/info/exclude');
  mkdirSync(join(context.cwd, '.git/info'), { recursive: true });
  writeFileSync(ignore, 'author-ignore\n');
  writeFileSync(gitExclude, 'private-ignore\n');
  await init();
  assert.deepEqual(json(file), expected);
  assert.equal(read(ignore), 'author-ignore\n');
  assert.equal(read(gitExclude), 'private-ignore\n');
  assert.equal(existsSync(join(context.cwd, '.praxity')), false);
  assert.deepEqual(json(registry).courses[0].vscodeSettings, expected);
  assert.deepEqual(validateSchema(json(registry), loadSchema('t3-actions-state')), []);
});

test('init preserves author settings, order, indentation and line endings, and owns only additions', async t => {
  const before = {
    'editor.fontSize': 16,
    'files.exclude': { '**/build': true, '**/.praxity-write-*': true },
    'editor.wordWrap': 'on',
    'search.exclude': { '**/private': false },
    'custom.settings': { nested: ['keep', { value: 'white space // in a string' }] },
  };
  const { file, registry, init } = setup(t, JSON.stringify(before, null, 4).replaceAll('\n', '\r\n') + '\r\n');
  await init();
  const after = {
    ...before,
    'files.exclude': { ...before['files.exclude'], '**/.praxity-transaction.json': true, '**/.praxity': true },
    'search.exclude': { ...before['search.exclude'], ...exclusions },
  };
  assert.equal(read(file), JSON.stringify(after, null, 4).replaceAll('\n', '\r\n') + '\r\n');
  assert.deepEqual(json(registry).courses[0].vscodeSettings, {
    'files.exclude': { '**/.praxity-transaction.json': true, '**/.praxity': true },
    'search.exclude': exclusions,
  });
  const state = read(registry), bytes = read(file);
  await init();
  assert.equal(read(registry), state);
  assert.equal(read(file), bytes);
});

test('init preserves and reports every explicit false, including identity, without claiming author entries', async t => {
  const before = { 'files.exclude': { '**/.praxity-write-*': false, '**/.praxity': false },
    'search.exclude': { '**/.praxity-transaction.json': false, '**/.praxity': false } };
  const { file, registry, init, messages } = setup(t, JSON.stringify(before));
  await init();
  assert.deepEqual(json(file), {
    'files.exclude': { ...before['files.exclude'], '**/.praxity-transaction.json': true },
    'search.exclude': { ...before['search.exclude'], '**/.praxity-write-*': true },
  });
  for (const [section, entries] of Object.entries(before)) for (const key of Object.keys(entries)) {
    assert.ok(messages.some(message => message.includes(section) && message.includes(key) && message.includes('false')));
  }
  assert.deepEqual(json(registry).courses[0].vscodeSettings, {
    'files.exclude': { '**/.praxity-transaction.json': true },
    'search.exclude': { '**/.praxity-write-*': true },
  });
});

test('init preserves conditional exclusions and never claims pre-existing true values', async t => {
  const before = { ...expected, 'files.exclude': { ...exclusions, '**/.praxity': { when: '$(basename).prax' } } };
  const bytes = JSON.stringify(before);
  const { file, registry, init } = setup(t, bytes);
  await init();
  assert.equal(read(file), bytes);
  assert.equal(json(registry).courses[0].vscodeSettings, undefined);
});

for (const bytes of [
  '{\n // Author comment\n "editor.fontSize": 16\n}',
  '{"files.exclude": {},}',
  '{bad', 'null', '[]',
  '{"files.exclude": false}', '{"search.exclude": []}',
  '{"files.exclude":null}',
  '{"author":1,"author":2}',
  '{"author":9007199254740993}',
  '{"2":"first","1":"second"}',
]) {
  test(`init leaves unsafe settings unchanged and prints manual exclusions: ${bytes}`, async t => {
    const { file, registry, init, messages } = setup(t, bytes);
    await init();
    assert.equal(read(file), bytes);
    assert.equal(json(registry).courses[0].vscodeSettings, undefined);
    const output = messages.join('\n');
    assert.match(output, /settings\.json.*unchanged/i);
    assert.ok(output.includes('files.exclude'));
    assert.ok(output.includes('search.exclude'));
    for (const key of Object.keys(exclusions)) assert.ok(output.includes(`"${key}": true`));
  });
}

test('init preserves malformed UTF-8 bytes and prints manual exclusions', async t => {
  const bytes = Buffer.concat([Buffer.from('{"editor.fontFamily":"caf'), Buffer.from([0xe9]), Buffer.from('"}\n')]);
  const { file, registry, init, messages } = setup(t, bytes);
  await init();
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(json(registry).courses[0].vscodeSettings, undefined);
  const output = messages.join('\n');
  assert.match(output, /settings\.json.*unchanged/i);
  assert.ok(output.includes('files.exclude'));
  assert.ok(output.includes('search.exclude'));
  for (const key of Object.keys(exclusions)) assert.ok(output.includes(`"${key}": true`));
});

test('init is byte and write idempotent for settings, actions and ownership', async t => {
  const { context, file, registry, init } = setup(t);
  await init();
  const files = [file, registry, join(context.cwd, 't3.json')];
  const before = files.map(path => ({ bytes: read(path), mtime: statSync(path).mtimeMs }));
  await init();
  assert.deepEqual(files.map(path => ({ bytes: read(path), mtime: statSync(path).mtimeMs })), before);
});

test('init releases ownership of author overrides and repairs deleted entries without claiming author additions', async t => {
  const { file, registry, init, messages } = setup(t);
  await init();
  writeFileSync(file, JSON.stringify({
    'files.exclude': { '**/.praxity': false },
    'search.exclude': { ...exclusions, '**/author': true },
  }));
  await init();
  assert.deepEqual(json(file), {
    'files.exclude': { '**/.praxity': false, '**/.praxity-write-*': true, '**/.praxity-transaction.json': true },
    'search.exclude': { ...exclusions, '**/author': true },
  });
  assert.deepEqual(json(registry).courses[0].vscodeSettings, {
    'files.exclude': { '**/.praxity-write-*': true, '**/.praxity-transaction.json': true },
    'search.exclude': exclusions,
  });
  assert.ok(messages.some(message => message.includes('**/.praxity') && message.includes('false')));
  const state = read(registry), bytes = read(file);
  await init();
  assert.equal(read(registry), state);
  assert.equal(read(file), bytes);
});

test('init creates no Git ignore files in a new project', async t => {
  const { context, init } = setup(t);
  await init();
  assert.equal(existsSync(join(context.cwd, '.gitignore')), false);
  assert.equal(existsSync(join(context.cwd, '.git')), false);
});

for (const field of [
  { vscodeSettings: { 'files.exclude': { '**/.praxity': false } } },
  { vscodeSettings: { 'files.exclude': { '**/author': true } } },
  { vscodeSettings: { 'unknown.exclude': {} } },
  { pendingVscodeSettings: { sha256: 'bad', entries: expected } },
  { pendingVscodeSettings: { sha256: '0'.repeat(64) } },
]) {
  test(`init rejects invalid settings ownership ${JSON.stringify(field)} without writes`, async t => {
    const { context, file, registry, init } = setup(t, '{}\n');
    mkdirSync(join(registry, '..'), { recursive: true });
    const state = JSON.stringify({ owner: 'praxity-toolkit', schemaVersion: 1,
      courses: [{ folder: context.cwd, port: 41891, ...field }] });
    writeFileSync(registry, state);
    await assert.rejects(init(), /Invalid project actions registry/);
    assert.equal(read(registry), state);
    assert.equal(read(file), '{}\n');
    assert.equal(existsSync(join(context.cwd, 't3.json')), false);
  });
}

for (const mode of ['before', 'after']) {
  test(`init recovers process death ${mode} the settings rename`, async t => {
    const { context, file, registry, init } = setup(t, '{}\n');
    const interrupted = interruptedInit(context, mode);
    assert.equal(interrupted.status, 91, interrupted.stderr);
    const pending = json(registry).courses[0];
    assert.equal(pending.vscodeSettings, undefined);
    assert.deepEqual(pending.pendingVscodeSettings.entries, expected);
    if (mode === 'before') assert.equal(read(file), '{}\n');
    else {
      assert.deepEqual(json(file), expected);
      assert.equal(pending.pendingVscodeSettings.sha256, createHash('sha256').update(read(file)).digest('hex'));
    }
    await init();
    assert.deepEqual(json(file), expected);
    assert.deepEqual(json(registry).courses[0].vscodeSettings, expected);
    assert.equal(json(registry).courses[0].pendingVscodeSettings, undefined);
  });
}

test('init preserves settings changed after reservation and retries with the new author settings', async t => {
  const { context, file, registry, init } = setup(t, '{}\n');
  const interrupted = interruptedInit(context, 'changed');
  assert.equal(interrupted.status, 92, interrupted.stderr);
  assert.match(interrupted.stderr, /VS Code settings changed during praxity init/);
  assert.equal(read(file), '{"author":true}\n');
  assert.equal(json(registry).courses[0].vscodeSettings, undefined);
  await init();
  assert.deepEqual(json(file), { author: true, ...expected });
  assert.deepEqual(json(registry).courses[0].vscodeSettings, expected);
});

for (const original of [undefined, '{"editor.fontSize":16}\n']) {
  test(`init preserves an author save during the settings flush, originally ${original === undefined ? 'absent' : 'present'}`, async t => {
    const { context, file, registry, init } = setup(t, original);
    const authorEdit = '{"editor.fontSize":24,"files.exclude":{"**/.praxity":false}}\n';
    const script = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import { syncBuiltinESMExports } from 'node:module';
      const write = fs.writeFileSync;
      let planted = false;
      fs.writeFileSync = (file, bytes, options) => {
        const result = write(file, bytes, options);
        if (!planted && String(file).replaceAll('\\\\', '/').includes('/.vscode/.praxity-init-')) {
          assert.equal(options.flush, true);
          planted = true;
          write(${JSON.stringify(file)}, ${JSON.stringify(authorEdit)});
        }
        return result;
      };
      syncBuiltinESMExports();
      const { runCli } = await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)});
      await assert.rejects(runCli(['init'], ${JSON.stringify({ cwd: context.cwd, home: context.home })},
        { print: () => {} }), /VS Code settings changed during praxity init; retry/);
      assert.ok(planted, 'Author save was planted after the durable temp-file flush');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(file), authorEdit);
    assert.equal(json(registry).courses[0].vscodeSettings, undefined);
    assert.deepEqual(readdirSync(join(context.cwd, '.vscode')), ['settings.json']);
    await init();
    assert.equal(json(file)['editor.fontSize'], 24);
    assert.equal(json(file)['files.exclude']['**/.praxity'], false);
    assert.equal(json(registry).courses[0].vscodeSettings['files.exclude']['**/.praxity'], undefined);
  });
}

test('init does not claim pending entries if the author changed settings after an interrupted write', async t => {
  const { file, registry, init, messages } = setup(t);
  await init();
  const state = json(registry), entry = state.courses[0];
  delete entry.vscodeSettings;
  entry.pendingVscodeSettings = { sha256: '0'.repeat(64), entries: expected };
  writeFileSync(registry, JSON.stringify(state, null, 2) + '\n');
  writeFileSync(file, JSON.stringify({ ...expected, author: true }));
  await init();
  assert.equal(json(registry).courses[0].vscodeSettings, undefined);
  assert.equal(json(registry).courses[0].pendingVscodeSettings, undefined);
  assert.ok(messages.some(message => /ownership.*unconfirmed/i.test(message)));
});

for (const linkedDirectory of [false, true]) {
  test(`init refuses linked VS Code ${linkedDirectory ? 'directory' : 'file'} without touching its target`, async t => {
    const { context, init } = setup(t), outside = join(context.root, 'outside');
    mkdirSync(outside);
    const target = join(outside, 'settings.json');
    writeFileSync(target, '{}\n');
    if (linkedDirectory) symlinkSync(outside, join(context.cwd, '.vscode'), process.platform === 'win32' ? 'junction' : 'dir');
    else {
      mkdirSync(join(context.cwd, '.vscode'));
      symlinkSync(target, join(context.cwd, '.vscode/settings.json'));
    }
    await assert.rejects(init(), /symlink refused/i);
    assert.equal(read(target), '{}\n');
  });
}

for (const directory of [false, true]) {
  test(`init refuses a ${directory ? 'non-directory .vscode' : 'non-file settings.json'}`, async t => {
    const { context, init } = setup(t);
    if (directory) writeFileSync(join(context.cwd, '.vscode'), 'author file\n');
    else mkdirSync(join(context.cwd, '.vscode/settings.json'), { recursive: true });
    await assert.rejects(init(), directory ? /Expected a VS Code settings directory/ : /Expected a JSON file/);
    if (directory) assert.equal(read(join(context.cwd, '.vscode')), 'author file\n');
    else assert.ok(statSync(join(context.cwd, '.vscode/settings.json')).isDirectory());
    assert.equal(existsSync(join(context.cwd, 't3.json')), false);
  });
}
