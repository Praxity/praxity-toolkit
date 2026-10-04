import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { doctor } from '../src/doctor.mjs';
import { loadSchema, validateSchema } from '../src/schema.mjs';
import { fixture, fakeTool } from './helpers.mjs';

function prepared(t) {
  const { context } = fixture(t);
  for (const id of ['studio', 'check', 'trace', 'print']) fakeTool(context, id);
  const typst = join(context.root, 'runtimes/typst/typst');
  mkdirSync(dirname(typst), { recursive: true }); writeFileSync(typst, 'fake binary');
  return context;
}
const checkResult = { components: [
  { id: 'browser', usable: false, source: null, version: null, inventory: 'absent' },
  { id: 'java', usable: true, source: 'setup', version: '17.0.19', inventory: 'intact' },
  { id: 'verapdf', usable: false, source: 'setup', version: '1.30.2', inventory: 'damaged', reason: 'Inventory damaged' },
], exitCode: 1 };
function runner(context, check = checkResult) {
  return ({ command, args }) => {
    if (args[0] === '--version') return { code: 0, stdout: `v${context.pack.runtimes.node.version}`, stderr: '' };
    if (args[0] === 'compile') { writeFileSync(args[2], '%PDF-1.7\nfake'); return { code: 0, stdout: '', stderr: '' }; }
    const id = command === context.node ? args[0].split(/[\\/]/).at(-2) : 'other';
    if (id === 'check') return { code: check.exitCode, stdout: JSON.stringify(check), stderr: '' };
    if (id === 'studio') return { code: 0, stdout: '{"schema":"praxity-inspect/1","lessons":[{}]}', stderr: '' };
    if (id === 'trace') { const out = args.at(-1); mkdirSync(out); writeFileSync(join(out, 'report.json'), '{"course":{}}'); return { code: 0, stdout: '', stderr: '' }; }
    if (id === 'print') { writeFileSync(args.at(-1), '%PDF-1.7\nfake'); return { code: 0, stdout: '{}', stderr: '' }; }
    throw new Error(`Unexpected probe: ${command} ${args}`);
  };
}
test('doctor aggregates ok, failed, declined and not-installed through its interface', t => {
  const context = prepared(t);
  writeFileSync(join(context.root, 'declined.json'), '{"check":["browser"]}');
  const result = doctor(context, runner(context));
  assert.deepEqual(validateSchema(result, loadSchema('doctor')), []);
  assert.equal(result.exitCode, 1);
  const status = Object.fromEntries(result.items.map(item => [item.id, item.status]));
  assert.equal(status['runtime.node'], 'ok'); assert.equal(status['runtime.typst'], 'ok');
  assert.equal(status['tool.check.browser'], 'declined'); assert.equal(status['tool.check.java'], 'ok');
  assert.equal(status['tool.check.verapdf'], 'failed'); assert.equal(status['tool.import'], 'not-installed');
  for (const id of ['studio', 'trace', 'print']) assert.equal(status[`tool.${id}`], 'ok');
  assert.equal(status['host.t3.user'], 'not-installed');
  assert.equal(result.items.find(item => item.id === 'tool.check.verapdf').fix, 'praxity setup check verapdf');
});
test('missing optional components are absent until the user explicitly refuses them', t => {
  const context = prepared(t);
  const result = doctor(context, runner(context));
  assert.equal(result.items.find(item => item.id === 'tool.check.browser').status, 'not-installed');
});
test('a usable component supersedes a past refusal', t => {
  const context = prepared(t);
  writeFileSync(join(context.root, 'declined.json'), '{"check":["java"]}');
  assert.equal(doctor(context, runner(context)).items.find(item => item.id === 'tool.check.java').status, 'ok');
});
test('malformed tool doctor and missing smoke artifacts fail visibly', t => {
  const context = prepared(t);
  const run = runner(context);
  const result = doctor(context, invocation => invocation.args.includes('doctor') ? { code: 0, stdout: '{}', stderr: '' }
    : invocation.args.includes('report') ? { code: 0, stdout: '', stderr: '' } : run(invocation));
  assert.equal(result.items.find(item => item.id === 'tool.check').status, 'failed');
  assert.equal(result.items.find(item => item.id === 'tool.trace').status, 'failed');
});
test('pin mismatch and process failure are bounded diagnostic failures', t => {
  const context = prepared(t);
  const run = runner(context);
  const result = doctor(context, invocation => invocation.args[0] === '--version' ? { code: 0, stdout: 'v25.0.0', stderr: '' }
    : invocation.args[0] === 'compile' ? { code: null, stdout: '', stderr: '', error: 'Timed out' } : run(invocation));
  assert.equal(result.items[0].status, 'failed'); assert.equal(result.items[1].message, 'Timed out');
});
