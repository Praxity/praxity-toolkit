import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { installJournal } from '../src/install-ledger.mjs';
import { archive, installation } from './installer-fixture.mjs';

function journalFixture(t) {
  const { home, root } = fixture(t), toolkit = join(home, 'toolkit');
  mkdirSync(toolkit);
  writeFileSync(join(toolkit, '.install-ledger.tsv'), 'praxity-toolkit-install-ledger-v1\n');
  return { home, root, toolkit, journal: () => installJournal(home, toolkit) };
}

test('journal reconciles partial archive writes, validates completion and preserves unrecorded additions', t => {
  const setup = journalFixture(t), source = join(setup.root, 'payload'), target = join(setup.toolkit, 'stage');
  mkdirSync(source); writeFileSync(join(source, 'NOTICE'), 'expected bytes');
  const file = join(setup.root, 'payload.tar.gz'); archive(source, file);
  setup.journal().archiveIntent(target, file, 0);
  mkdirSync(target);
  assert.throws(() => setup.journal().complete(target), /Missing intended output/);
  writeFileSync(join(target, 'NOTICE'), 'partial');
  assert.throws(() => setup.journal().complete(target), /damaged|changed/);
  setup.journal().remove(target); assert.equal(existsSync(target), false);
  setup.journal().archiveIntent(target, file, 0); cpSync(source, target, { recursive: true });
  writeFileSync(join(target, 'user'), 'USER FILE');
  assert.throws(() => setup.journal().complete(target), /unowned/);
  assert.throws(() => setup.journal().remove(target), /unowned/);
  assert.equal(readFileSync(join(target, 'user'), 'utf8'), 'USER FILE');
});

test('copied and renamed tree intentions survive a fresh journal reader', t => {
  const setup = journalFixture(t), source = join(setup.root, 'source'), stage = join(setup.toolkit, 'stage'), version = join(setup.toolkit, '0.1.0');
  mkdirSync(source); writeFileSync(join(source, 'NOTICE'), 'expected bytes');
  setup.journal().copyIntent(stage, source); cpSync(source, stage, { recursive: true });
  setup.journal().complete(stage);
  setup.journal().moveIntent(version, stage); renameSync(stage, version);
  setup.journal().complete(version);
  writeFileSync(join(version, 'NOTICE'), 'USER EDIT');
  assert.throws(() => setup.journal().remove(version), /damaged|changed/);
  assert.equal(readFileSync(join(version, 'NOTICE'), 'utf8'), 'USER EDIT');
});

test('a corrupted pending hash stops uninstall before any recorded file is removed', t => {
  const setup = installation(t, { tool: false });
  mkdirSync(setup.toolkit, { recursive: true });
  const file = join(setup.toolkit, 'keep'); writeFileSync(file, 'KEEP THESE BYTES');
  writeFileSync(join(setup.toolkit, '.install-ledger.tsv'), 'praxity-toolkit-install-ledger-v1\nP\ttruncated\t.praxity/toolkit/keep\n');
  const result = setup.action('uninstall'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /corrupt.*journal/i);
  assert.equal(readFileSync(file, 'utf8'), 'KEEP THESE BYTES');
});
