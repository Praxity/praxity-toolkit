import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli, loadContext } from '../src/cli.mjs';
import { probeProcess } from '../src/tools.mjs';
import { fixture, repository } from './helpers.mjs';
import { installation, posix, quote, replaceInstalled, shell } from './installer-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const channel = 'https://api.github.com/repos/Praxity/rubato/releases/latest';
const releaseBase = 'https://github.com/Praxity/rubato/releases/download/v0.2.0/';
const studioSha = 'abcdef0123456789abcdef0123456789abcdef01';
const passed = result => assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
function releaseArchive(root, file, member) {
  passed(shell(`tar -czf ${quote(posix(file))} -C ${quote(posix(root))} ${quote(member)}`));
  return readFileSync(file);
}

function releaseFixture(t) {
  const setup = installation(t, { tools: ['studio'] });
  passed(setup.install());
  t.diagnostic('Old pack installed; exercising update with local release bytes.');
  const project = join(setup.root, 'course'); mkdirSync(project);
  const context = { ...loadContext(join(setup.toolkit, '0.1.0')), home: setup.home, cwd: project, env: setup.env };
  const launcher = join(setup.home, '.praxity/bin/praxity');
  const cli = args => shell(`${quote(posix(launcher))} ${args}`, { env: setup.env, cwd: project });
  const tool = setup.pack.tools.find(tool => tool.id === 'studio');
  const updatedSkill = '---\nname: prax-format\ndescription: Write a course.\n---\nUpdated skill.\n';
  writeFileSync(join(setup.root, 'fake studio', tool.skillPath, 'SKILL.md'), updatedSkill);
  writeFileSync(join(setup.root, 'fake studio', tool.entry), 'console.log("NEW STUDIO");\n');
  const studioRoot = join(setup.root, 'studio-release'), studioArchives = {};
  mkdirSync(studioRoot);
  cpSync(join(setup.root, 'fake studio'), join(studioRoot, 'studio-cli'), { recursive: true });
  for (const arch of ['arm64', 'x64']) {
    const file = join(setup.root, `praxity-cli-0.3.0-macos-${arch}.tar.gz`);
    const bytes = releaseArchive(studioRoot, file, 'studio-cli');
    studioArchives[arch] = file;
    tool.archives[`darwin-${arch}`] = { ...tool.archives['darwin-arm64'],
      url: pathToFileURL(file).href,
      sha256: hash(bytes), stripComponents: 1 };
  }
  tool.version = '0.3.0-main.abcdef01';
  setup.pack.version = '0.2.0';
  tool.sourceRevision = studioSha;
  setup.pack.platforms = ['darwin-arm64', 'darwin-x64'];
  for (const artifact of [...Object.values(setup.pack.runtimes), ...setup.pack.tools.filter(value => value.id !== 'studio')]) {
    artifact.archives['darwin-x64'] = { ...artifact.archives['darwin-arm64'] };
  }
  writeFileSync(setup.manifest, JSON.stringify(setup.pack, null, 2) + '\n');
  const bootstrapRoot = join(setup.root, 'release-bootstrap'), bootstrap = join(bootstrapRoot, 'rubato'); mkdirSync(bootstrap, { recursive: true });
  for (const name of ['src', 'scripts', 'schemas', 'skills', 'fixtures', 'install.sh', 'package.json', 'LICENSE']) {
    cpSync(join(repository, name), join(bootstrap, name), { recursive: true });
  }
  cpSync(setup.manifest, join(bootstrap, 'pack.json'));
  writeFileSync(join(bootstrap, 'package.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(bootstrap, 'package.json'))), version: '0.2.0' }, null, 2) + '\n');
  const bootstrapFile = join(setup.root, 'bootstrap.tar.gz');
  const bootstrapBytes = releaseArchive(bootstrapRoot, bootstrapFile, 'rubato');
  const files = new Map([
    ['pack.json', readFileSync(setup.manifest)],
    ['rubato-0.2.0.tar.gz', bootstrapBytes],
    ...Object.values(studioArchives).map(file => [file.split(/[\\/]/).at(-1), readFileSync(file)]),
  ]);
  const sums = () => files.set('SHA256SUMS', Buffer.from([...files].filter(([name]) => name !== 'SHA256SUMS').map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join('')));
  sums();
  const metadata = { tag_name: 'v0.2.0', draft: false, prerelease: false, immutable: true,
    assets: [...files.keys()].map(name => ({ name, browser_download_url: releaseBase + name })) };
  const requests = [], commands = [], output = [];
  let processes = '';
  const dependencies = {
    print: value => output.push(value),
    fetch: async url => {
      requests.push(String(url));
      if (url === channel) return new Response(JSON.stringify(metadata));
      const base = `https://github.com/Praxity/rubato/releases/download/${metadata.tag_name}/`;
      assert.ok(String(url).startsWith(base), `Unexpected release URL: ${url}`);
      const bytes = files.get(String(url).slice(base.length));
      assert.ok(bytes, `Unexpected release asset: ${url}`);
      return new Response(bytes);
    },
    updateProcess: (invocation, options) => {
      commands.push(invocation);
      if (invocation.command === 'ps') return { code: 0, stdout: processes, stderr: '' };
      if (invocation.command === 'sh') {
        const args = invocation.args.map((arg, i) => quote(i === 0 ? posix(arg) : arg));
        const result = shell(`sh ${args.join(' ')}`, { env: setup.env, cwd: options?.cwd ?? project });
        output.push(result.stdout, result.stderr);
        if (result.status !== 0) t.diagnostic(`Release subprocess failed: ${result.stdout}\n${result.stderr}`);
        return { code: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message };
      }
      return probeProcess(invocation, options);
    },
  };
  return { ...setup, project, context, cli, bootstrap, bootstrapRoot, studioArchives, files, sums, metadata, requests, commands, output, dependencies, updatedSkill,
    busy: value => { processes = value; }, update: () => runCli(['update'], context, dependencies) };
}

test('update installs the verified release, refreshes both scopes, retains rollback and launches the new Studio', async t => {
  const f = releaseFixture(t);
  passed(f.cli('skills install --host claude --scope user'));
  passed(f.cli('skills install --host codex --scope project'));
  const unowned = join(f.project, '.agents/skills/my-notes/SKILL.md');
  mkdirSync(dirname(unowned)); writeFileSync(unowned, 'MY NOTES');
  assert.equal(await f.update(), 0);
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.2.0\n0.1.0\n');
  assert.equal(JSON.parse(f.cli('version').stdout).studioSha, studioSha);
  for (const [base, folder] of [[f.home, '.claude'], [f.project, '.agents']]) {
    assert.equal(readFileSync(join(base, folder, 'skills/prax-format/SKILL.md'), 'utf8'), f.updatedSkill);
  }
  assert.equal(readFileSync(unowned, 'utf8'), 'MY NOTES');
  assert.match(f.cli('studio . --no-open').stdout, /NEW STUDIO/);
  assert.ok(f.requests.includes(releaseBase + 'rubato-0.2.0.tar.gz'));
  const checksumNames = f.files.get('SHA256SUMS').toString().trim().split('\n').map(line => line.split('  ')[1]).sort();
  assert.deepEqual(checksumNames, ['pack.json', 'praxity-cli-0.3.0-macos-arm64.tar.gz', 'praxity-cli-0.3.0-macos-x64.tar.gz', 'rubato-0.2.0.tar.gz']);
  assert.match(f.output.join('\n'), /next Studio launch/i);
  passed(f.cli('rollback'));
  assert.equal(JSON.parse(f.cli('version').stdout).pack, '0.1.0');
});

for (const scope of ['user', 'project']) test(`update preserves modified ${scope} skills and reports how to retry`, async t => {
  const f = releaseFixture(t);
  passed(f.cli(`skills install --host claude --scope ${scope}`));
  const edited = join(scope === 'user' ? f.home : f.project, '.claude/skills/prax-format/SKILL.md');
  writeFileSync(edited, 'MY EDITS');
  const code = await f.update();
  if (scope === 'project') assert.equal(code, 1);
  assert.equal(readFileSync(edited, 'utf8'), 'MY EDITS');
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.2.0\n0.1.0\n');
  assert.match(f.output.join('\n'), new RegExp(`skills refresh --scope ${scope}`));
});

test('busy Studio refuses before downloading, preserves the session and gives save-and-close instructions', async t => {
  const f = releaseFixture(t);
  const entry = join(f.toolkit, '0.1.0/tools/studio/praxity.mjs');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', entry], { stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  });
  f.busy(`${child.pid} node ${posix(entry)} studio . --no-open\n`);
  if (process.platform !== 'win32') {
    const run = f.dependencies.updateProcess;
    f.dependencies.updateProcess = (invocation, options) => {
      if (invocation.command !== 'ps') return run(invocation, options);
      f.commands.push(invocation);
      return probeProcess(invocation, options);
    };
  }
  await assert.rejects(f.update(), /Save or copy.*unsaved text.*close.*Studio.*Ctrl\+C/s);
  assert.equal(child.killed, false);
  assert.equal(child.exitCode, null);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.commands.map(command => command.command), ['ps']);
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
});

test('an unrelated Studio process is left alone and does not block the owned pack', async t => {
  const f = releaseFixture(t);
  f.busy('123 node /another/app/tools/studio/praxity.mjs studio .\n');
  assert.equal(await f.update(), 0);
  assert.ok(f.commands.every(command => command.command !== 'kill'));
});

for (const target of ['pack.json', 'rubato-0.2.0.tar.gz', 'tool archive']) test(`tampered ${target} leaves the old pack active`, async t => {
  const f = releaseFixture(t);
  if (target === 'tool archive') writeFileSync(f.studioArchives.arm64, 'TAMPERED');
  else f.files.set(target, Buffer.from('TAMPERED'));
  await assert.rejects(f.update(), /SHA-256|Checksum mismatch|installer failed/i);
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
  assert.equal(existsSync(join(f.toolkit, '0.2.0')), false);
});

test('network failure leaves the old pack active', async t => {
  const f = releaseFixture(t);
  const fetchRelease = f.dependencies.fetch;
  for (const failedUrl of [channel, releaseBase + 'pack.json', releaseBase + 'rubato-0.2.0.tar.gz']) {
    f.dependencies.fetch = async url => {
      if (url === failedUrl) throw new Error('offline fixture');
      return fetchRelease(url);
    };
    await assert.rejects(f.update(), /offline fixture/);
    assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
  }
});

test('a Studio session started during download refuses before the installer', async t => {
  const f = releaseFixture(t), fetchRelease = f.dependencies.fetch;
  f.dependencies.fetch = async url => {
    if (url.endsWith('.tar.gz')) f.busy(`123 node ${posix(join(f.toolkit, '0.1.0/tools/studio/praxity.mjs'))} studio .\n`);
    return fetchRelease(url);
  };
  await assert.rejects(f.update(), /Studio may hold unsaved text/);
  assert.ok(!f.commands.some(command => command.command === 'sh'));
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
});

for (const violation of ['foreign asset', 'missing asset', 'duplicate asset', 'missing checksum', 'duplicate checksum', 'draft', 'prerelease', 'mutable release', 'missing immutability', 'invalid tag', 'wrong tag', 'manifest version', 'bootstrap manifest', 'bootstrap link']) test(`update rejects ${violation} before invoking the installer`, async t => {
  const f = releaseFixture(t);
  if (violation === 'foreign asset') f.metadata.assets[0].browser_download_url = 'https://example.com/pack.json';
  if (violation === 'missing asset') f.metadata.assets = [];
  if (violation === 'duplicate asset') f.metadata.assets.push(f.metadata.assets[0]);
  if (violation === 'missing checksum') f.files.set('SHA256SUMS', Buffer.from(''));
  if (violation === 'duplicate checksum') f.files.set('SHA256SUMS', Buffer.concat([f.files.get('SHA256SUMS'), f.files.get('SHA256SUMS')]));
  if (violation === 'draft') f.metadata.draft = true;
  if (violation === 'prerelease') f.metadata.prerelease = true;
  if (violation === 'mutable release') f.metadata.immutable = false;
  if (violation === 'missing immutability') delete f.metadata.immutable;
  if (violation === 'invalid tag') {
    f.metadata.tag_name = '../release';
    for (const asset of f.metadata.assets) asset.browser_download_url = `https://github.com/Praxity/rubato/releases/download/../release/${asset.name}`;
  }
  if (violation === 'wrong tag') f.metadata.tag_name = 'v0.3.0';
  if (violation === 'manifest version') {
    f.pack.version = '0.3.0';
    writeFileSync(join(f.bootstrap, 'package.json'), JSON.stringify({ version: '0.3.0', type: 'module' }));
    repack(f);
    f.files.set('rubato-0.3.0.tar.gz', f.files.get('rubato-0.2.0.tar.gz'));
    f.metadata.assets.push({ name: 'rubato-0.3.0.tar.gz', browser_download_url: releaseBase + 'rubato-0.3.0.tar.gz' });
    f.sums();
  }
  if (violation === 'bootstrap manifest' || violation === 'bootstrap link') {
    if (violation === 'bootstrap manifest') writeFileSync(join(f.bootstrap, 'pack.json'), '{}');
    else symlinkSync(f.project, join(f.bootstrap, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const file = join(f.root, 'different-bootstrap.tar.gz');
    f.files.set('rubato-0.2.0.tar.gz', releaseArchive(f.bootstrapRoot, file, 'rubato')); f.sums();
  }
  const expected = violation === 'manifest version' ? /^Release tag does not match its manifest$/
    : ['invalid tag', 'mutable release', 'missing immutability'].includes(violation) ? /^Invalid official stable release$/
    : /official|checksum|SHA-256|release|manifest/i;
  await assert.rejects(f.update(), error => { assert.match(error.message, expected); return true; });
  assert.ok(!f.commands.some(command => command.command === 'sh'));
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
});

test('extraction and installer launch errors leave the old pack active', async t => {
  const f = releaseFixture(t), run = f.dependencies.updateProcess;
  for (const failedCommand of ['tar', 'sh']) {
    f.dependencies.updateProcess = (invocation, options) => invocation.command === failedCommand
      ? { code: null, error: 'fixture process launch failed' }
      : run(invocation, options);
    await assert.rejects(f.update(), /fixture process launch failed/);
    assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
  }
});

test('update takes no URL or digest arguments and version reports a legacy Studio SHA', async t => {
  const f = fixture(t);
  await assert.rejects(runCli(['update', '--manifest', 'https://example.com/pack.json'], f.context), /Usage: praxity update/);
  const lines = [];
  await runCli(['version'], f.context, { print: line => lines.push(line) });
  assert.equal(JSON.parse(lines[0]).studioSha, '92e21573');
});

test('process inspection errors refuse before network access', async t => {
  const { context } = fixture(t);
  let downloads = 0;
  await assert.rejects(runCli(['update'], context, {
    updateProcess: () => ({ code: 1, stderr: 'ps unavailable' }),
    fetch: () => { downloads++; throw new Error('unexpected download'); },
  }), /Cannot check running Studio sessions.*Save or copy.*ps unavailable/);
  assert.equal(downloads, 0);
});

test('an HTTP failure reports the status without running an installer', async t => {
  const { context } = fixture(t);
  const commands = [];
  await assert.rejects(runCli(['update'], context, {
    updateProcess: invocation => { commands.push(invocation.command); return { code: 0, stdout: '' }; },
    fetch: async () => new Response('missing', { status: 404 }),
  }), /HTTP 404/);
  assert.deepEqual(commands, ['ps']);
});

for (const current of ['0.2.0', '0.3.0']) test(`pack ${current} does not downgrade to or reinstall release 0.2.0`, async t => {
  const { context } = fixture(t);
  context.pack.version = current;
  const pack = { ...context.pack, version: '0.2.0' }, manifest = Buffer.from(JSON.stringify(pack));
  const requests = [], commands = [];
  assert.equal(await runCli(['update'], context, {
    print: () => {},
    updateProcess: invocation => { commands.push(invocation.command); return { code: 0, stdout: '' }; },
    fetch: async (url, options) => {
      assert.equal(options.headers?.Accept, url === channel ? 'application/vnd.github+json' : undefined);
      requests.push(url);
      if (url === channel) return new Response(JSON.stringify({ tag_name: 'v0.2.0', draft: false, prerelease: false, immutable: true,
        assets: ['pack.json', 'SHA256SUMS'].map(name => ({ name, browser_download_url: releaseBase + name })) }));
      return new Response(url.endsWith('pack.json') ? manifest : `${hash(manifest)}  pack.json\n`);
    },
  }), 0);
  assert.ok(requests.every(url => !url.endsWith('.tar.gz')));
  assert.deepEqual(commands, ['ps']);
});

function repack(f) {
  const manifest = Buffer.from(JSON.stringify(f.pack, null, 2) + '\n');
  f.files.set('pack.json', manifest);
  writeFileSync(join(f.bootstrap, 'pack.json'), manifest);
  f.files.set('rubato-0.2.0.tar.gz', releaseArchive(f.bootstrapRoot, join(f.root, 'repacked.tar.gz'), 'rubato'));
  f.sums();
}

for (const extra of ['sourceRevision', 'futureField']) test(`update validates ${extra} with the new release schema`, async t => {
  const f = releaseFixture(t);
  const schemaFile = join(f.toolkit, '0.1.0/schemas/pack.schema.json');
  const oldSchema = JSON.parse(readFileSync(schemaFile));
  delete oldSchema.$defs.tool.properties.sourceRevision;
  replaceInstalled(f, '0.1.0', 'schemas/pack.schema.json', JSON.stringify(oldSchema));
  if (extra === 'futureField') {
    f.pack.tools[0].futureField = 'new release field';
    const newSchemaFile = join(f.bootstrap, 'schemas/pack.schema.json');
    const schema = JSON.parse(readFileSync(newSchemaFile));
    schema.$defs.tool.properties.futureField = { type: 'string' };
    writeFileSync(newSchemaFile, JSON.stringify(schema));
    repack(f);
  }
  const { runCli: installedCli } = await import(pathToFileURL(join(f.toolkit, '0.1.0/src/cli.mjs')));
  assert.equal(await installedCli(['update'], f.context, f.dependencies), 0);
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.2.0\n0.1.0\n');
});

for (const violation of ['unknown field', 'missing required field', 'malformed required field', 'malformed version']) test(`new release schema rejects ${violation}`, async t => {
  const f = releaseFixture(t);
  if (violation === 'unknown field') f.pack.tools[0].unknownExtraField = 'unsupported';
  if (violation === 'missing required field') delete f.pack.runtimes;
  if (violation === 'malformed required field') f.pack.tools[0].entry = '../escape';
  if (violation === 'malformed version') f.pack.version = '../../escape';
  repack(f);
  await assert.rejects(f.update(), /Invalid pack manifest/);
  assert.ok(!f.commands.some(command => command.command === 'sh'));
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
});

test('update from a project subfolder refreshes the nearest recorded project', async t => {
  const f = releaseFixture(t);
  passed(f.cli('skills install --host codex --scope project'));
  const nested = join(f.project, 'lessons', 'unit'); mkdirSync(nested, { recursive: true });
  f.context.cwd = nested;
  assert.equal(await f.update(), 0);
  assert.equal(readFileSync(join(f.project, '.agents/skills/prax-format/SKILL.md'), 'utf8'), f.updatedSkill);
  assert.equal(existsSync(join(nested, '.praxity')), false);
});

test('update rejects hard links in the release bootstrap', async t => {
  const f = releaseFixture(t);
  linkSync(join(f.bootstrap, 'install.sh'), join(f.bootstrap, 'installer-copy.sh'));
  repack(f);
  await assert.rejects(f.update(), /Unsafe release bootstrap link/);
  assert.ok(!f.commands.some(command => command.command === 'sh'));
  assert.equal(readFileSync(join(f.toolkit, 'active'), 'utf8'), '0.1.0\n\n');
});
