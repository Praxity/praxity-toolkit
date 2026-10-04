import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.mjs';
import { loadSchema, validateSchema } from '../src/schema.mjs';
import { executeTool, toolInvocation } from '../src/tools.mjs';
import { fixture, fakeTool } from './helpers.mjs';

test('tool commands dispatch unchanged; all other arguments reach Studio unchanged', async t => {
  const { context } = fixture(t);
  const calls = [];
  const execute = async (_, tool, args) => { calls.push([tool.id, args]); return 7; };
  for (const id of ['check', 'trace', 'print', 'import']) {
    assert.equal(await runCli([id, 'run', 'path with spaces', '--flag'], context, { execute }), 7);
    assert.deepEqual(calls.at(-1), [id, ['run', 'path with spaces', '--flag']]);
  }
  for (const args of [[], ['--help'], ['studio', '.', '--no-open'], ['inspect', 'course', '--schema', '1'], ['export', '--unknown']]) {
    await runCli(args, context, { execute });
    assert.deepEqual(calls.at(-1), ['studio', args]);
  }
});
test('setup uses tool-owned commands and never adds consent flags', async t => {
  const { context } = fixture(t);
  context.state.installed = ['check', 'studio'];
  const calls = [];
  const execute = async (_, tool, args) => { calls.push([tool.id, args]); return 0; };
  await runCli(['setup'], context, { execute });
  await runCli(['setup', 'check', 'browser'], context, { execute });
  assert.deepEqual(calls, [['check', ['setup']], ['check', ['setup', 'browser']]]);
  await assert.rejects(runCli(['setup', 'unknown'], context, { execute }), /Unknown tool/);
});
test('version, doctor JSON and rollback dispatch have stable boundaries', async t => {
  const { context } = fixture(t);
  const output = [];
  await runCli(['version'], context, { print: value => output.push(value) });
  assert.equal(JSON.parse(output.pop()).pack, '0.1.0');
  const result = { schemaVersion: 1, packVersion: '0.1.0', items: [], exitCode: 1 };
  assert.equal(await runCli(['doctor', '--json'], context, { doctor: () => result, print: value => output.push(value) }), 1);
  assert.deepEqual(JSON.parse(output.pop()), result);
  const calls = [];
  assert.equal(await runCli(['rollback'], context, { rollback: (...args) => { calls.push(args); return { code: 0 }; } }), 0);
  assert.deepEqual(calls[0][0].args, [join(context.root, 'install.sh'), 'rollback']);
  await assert.rejects(runCli(['doctor', '--unknown'], context), /Usage/);
  await assert.rejects(runCli(['skills', 'install', '--host', 'bad', '--scope', 'user'], context), /valid/);
});
test('real process seam preserves arguments and exit codes', async t => {
  const { context } = fixture(t);
  const tool = fakeTool(context, 'trace', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(context.root, 'args.json'))}, JSON.stringify(process.argv.slice(2))); process.exitCode = 9;`);
  assert.equal(await executeTool(context, tool, ['path with spaces', 'literal $() ;']), 9);
  assert.deepEqual(JSON.parse(readFileSync(join(context.root, 'args.json'), 'utf8')), ['path with spaces', 'literal $() ;']);
  assert.equal(toolInvocation(context, tool, []).command, process.execPath);
  await assert.rejects(runCli(['print'], context), /not installed/);
});
test('explicit Check setup refusal is recorded without capturing a missing component as refusal', async t => {
  const { context } = fixture(t);
  const tool = fakeTool(context, 'check', `console.log('browser: declined; dependent checks will report not run');`);
  assert.equal(await executeTool(context, tool, ['setup']), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(context.root, 'declined.json'), 'utf8')), { check: ['browser'] });
  assert.equal(existsSync(join(context.root, 'args.json')), false);
});

test('Studio process preserves empty, quoted, Unicode and shell-like arguments; doctor JSON validates', async t => {
  const { context } = fixture(t), argsFile = join(context.root, 'studio-args.json');
  fakeTool(context, 'studio', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2))); process.exitCode=7;`);
  const expected = ['studio', 'path with spaces', '--no-open', '', "apostrophe's", 'literal $() ;', '--', '?'];
  assert.equal(await runCli(expected, context), 7);
  assert.deepEqual(JSON.parse(readFileSync(argsFile)), expected);
  context.state.installed = [];
  let output;
  const code = await runCli(['doctor', '--json'], context, { print: value => { output = value; } });
  const report = JSON.parse(output);
  assert.deepEqual(validateSchema(report, loadSchema('doctor')), []);
  assert.equal(code, report.exitCode);
});
