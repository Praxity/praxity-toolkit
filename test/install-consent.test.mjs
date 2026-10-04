import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { installation, archive } from './installer-fixture.mjs';
import { loadContext } from '../src/cli.mjs';
import { executeTool } from '../src/tools.mjs';

test('Check setup refusal survives rerun, update, rollback and uninstall outside the pack', async t => {
  const setup = installation(t, { tool: false }), payload = join(setup.root, 'check'); mkdirSync(payload);
  writeFileSync(join(payload, 'check.mjs'), "console.log('browser: declined; dependent checks will report not run');\n");
  writeFileSync(join(payload, 'NOTICES'), 'fixture legal\n');
  const tool = setup.pack.tools.find(tool => tool.id === 'check');
  tool.entry = 'check.mjs'; tool.notices = 'NOTICES'; delete tool.skillPath;
  tool.archives['darwin-arm64'] = archive(payload, join(setup.root, 'check.tar.gz')); setup.save();
  const first = setup.install(); assert.equal(first.status, 0, first.stderr);
  const context = loadContext(join(setup.toolkit, '0.1.0'));
  context.home = setup.home; context.env = setup.env; context.node = process.execPath;
  assert.equal(await executeTool(context, tool, ['setup', 'browser']), 0);
  const stateFile = join(setup.home, '.praxity/toolkit-state/declined.json');
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { check: ['browser'] });
  assert.equal(existsSync(join(context.root, 'declined.json')), false);
  const rerun = setup.install(); assert.equal(rerun.status, 0, rerun.stderr);
  setup.pack.version = '0.2.0'; setup.save();
  const update = setup.install(); assert.equal(update.status, 0, update.stderr);
  const rollback = setup.action('rollback'); assert.equal(rollback.status, 0, rollback.stderr);
  const uninstall = setup.action('uninstall'); assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { check: ['browser'] });
});
