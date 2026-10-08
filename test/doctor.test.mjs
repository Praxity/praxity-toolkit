import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { doctor } from '../src/doctor.mjs';
import { loadSchema, validateSchema } from '../src/schema.mjs';
import { fixture, fakeTool } from './helpers.mjs';

function prepared(t) {
  const { context } = fixture(t);
  mkdirSync(join(context.home, '.praxity/toolkit-state'), { recursive: true });
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
    if (id === 'import') {
      const out = args.at(-1); mkdirSync(out); writeFileSync(join(out, 'course.yaml'), 'title: "Tiny import"\n');
      return { code: 0, stdout: JSON.stringify(check.importResult ?? { ok: true, title: 'Tiny import', lessons: 1, pages: 1, assets: 0, losses: 0 }), stderr: '' };
    }
    throw new Error(`Unexpected probe: ${command} ${args}`);
  };
}
test('doctor aggregates ok, failed, declined and not-installed through its interface', t => {
  const context = prepared(t);
  writeFileSync(join(context.home, '.praxity/toolkit-state/declined.json'), '{"check":["browser"]}');
  const result = doctor(context, runner(context));
  assert.deepEqual(validateSchema(result, loadSchema('doctor')), []);
  assert.equal(result.exitCode, 1);
  const status = Object.fromEntries(result.items.map(item => [item.id, item.status]));
  assert.equal(status['runtime.node'], 'ok'); assert.equal(status['runtime.typst'], 'ok');
  assert.equal(status['tool.check.browser'], 'declined'); assert.equal(status['tool.check.java'], 'ok');
  assert.equal(status['tool.check.verapdf'], 'failed'); assert.equal(status['tool.import'], 'not-installed');
  for (const id of ['studio', 'trace', 'print']) assert.equal(status[`tool.${id}`], 'ok');
  assert.equal(status['host.claude.user'], 'not-installed');
  assert.equal(result.items.find(item => item.id === 'tool.check.verapdf').fix, 'praxity setup check verapdf');
});
test('missing optional components are absent until the user explicitly refuses them', t => {
  const context = prepared(t);
  const result = doctor(context, runner(context));
  assert.equal(result.items.find(item => item.id === 'tool.check.browser').status, 'not-installed');
});
test('a usable component supersedes a past refusal', t => {
  const context = prepared(t);
  writeFileSync(join(context.home, '.praxity/toolkit-state/declined.json'), '{"check":["java"]}');
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

test('an unusable system Java, such as the macOS stub, is not installed rather than failed', t => {
  const context = prepared(t);
  const check = { components: [{ id: 'java', usable: false, source: 'system', path: '/usr/bin/java', version: null, inventory: 'unmanaged', reason: 'Java 17 or newer is not installed; checks not run. Run check setup pdf.' }], exitCode: 1 };
  const report = doctor(context, runner(context, check));
  assert.equal(report.items.find(item => item.id === 'tool.check.java').status, 'not-installed');
  assert.equal(report.exitCode, 0);
  writeFileSync(join(context.home, '.praxity/toolkit-state/declined.json'), '{"check":["java"]}');
  assert.equal(doctor(context, runner(context, check)).items.find(item => item.id === 'tool.check.java').status, 'declined');
});
test('import is ok only when it converts the shipped SCORM fixture without losses', t => {
  const context = prepared(t);
  fakeTool(context, 'import');
  const status = check => doctor(context, runner(context, check)).items.find(item => item.id === 'tool.import');
  const passed = status(checkResult);
  assert.equal(passed.status, 'ok'); assert.equal(passed.message, 'Functional smoke probe passed');
  assert.equal(status({ ...checkResult, importResult: { ok: true, lessons: 1, pages: 1, losses: 2 } }).status, 'failed');
  assert.equal(status({ ...checkResult, importResult: { ok: false } }).status, 'failed');
});
test('an explicitly selected component that does not work still fails', t => {
  const context = prepared(t);
  const check = { components: [{ id: 'java', usable: false, source: 'explicit', path: '/opt/java/bin/java', version: '11.0.2', inventory: 'unmanaged', reason: 'Java selected by JAVA_HOME is unusable' }], exitCode: 1 };
  const report = doctor(context, runner(context, check));
  assert.equal(report.items.find(item => item.id === 'tool.check.java').status, 'failed');
  assert.equal(report.exitCode, 1);
});

for (const inventory of ['intact', 'damaged', 'unmanaged']) test(`past refusal cannot mask a present ${inventory} component failure`, t => {
  const context = prepared(t);
  writeFileSync(join(context.home, '.praxity/toolkit-state/declined.json'), '{"check":["browser"]}');
  const check = { components: [{ id: 'browser', usable: false, source: 'setup', inventory, reason: 'Browser failed to launch' }], exitCode: 1 };
  const report = doctor(context, runner(context, check));
  assert.equal(report.items.find(item => item.id === 'tool.check.browser').status, 'failed');
  assert.equal(report.exitCode, 1);
});

test('doctor names the PATH line when praxity is not on PATH, without failing', t => {
  const context = prepared(t);
  const bin = join(context.root, 'bin'); mkdirSync(bin);
  const path = () => doctor({ ...context, env: { ...context.env, PATH: [context.root, bin].join(delimiter) } }, runner(context));
  const missing = path();
  const item = missing.items.find(item => item.id === 'launcher.path');
  assert.equal(item.status, 'not-installed');
  assert.match(item.fix, /export PATH="\$HOME\/\.praxity\/bin:\$PATH"/);
  assert.equal(missing.items.find(item => item.status === 'failed' && item.id === 'launcher.path'), undefined);
  writeFileSync(join(bin, 'praxity'), '#!/bin/sh\n');
  assert.equal(path().items.find(item => item.id === 'launcher.path').status, 'ok');
});

test('a missing Check browser says HTML checks cannot run and names the setup command', t => {
  const context = prepared(t);
  const item = doctor(context, runner(context)).items.find(item => item.id === 'tool.check.browser');
  assert.equal(item.status, 'not-installed');
  assert.match(item.message, /cannot audit HTML and exits 2/);
  assert.equal(item.fix, 'praxity setup check html');
});
