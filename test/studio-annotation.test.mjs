import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, repository } from './helpers.mjs';
import { resolveAnnotationSelector } from '../skills/studio-editor/scripts/resolve-annotation.mjs';

// The browser document is the seam. Selector parsing belongs to the browser.
function element(attributes = {}, text = '', parent = null) {
  return {
    innerText: text,
    parentElement: parent,
    getAttribute: name => attributes[name] ?? null,
    closest(selector) {
      assert.equal(selector, '[data-node-id]');
      for (let current = this; current; current = current.parentElement) {
        if (current.getAttribute('data-node-id') !== null) return current;
      }
      return null;
    },
  };
}

function probe(selector, selected, markers, pageUrl = 'http://localhost:41700/lesson.html') {
  const document = {
    location: { href: pageUrl },
    querySelectorAll(value) {
      if (value === '[data-node-id]') return markers;
      assert.equal(value, selector);
      if (selected instanceof Error) throw selected;
      return selected;
    },
  };
  // Run the same self-contained function expression the preview receives.
  const expression = `(${resolveAnnotationSelector.toString()})(${JSON.stringify(selector)})`;
  const context = { document, compromised: false };
  const result = runInNewContext(expression, context);
  assert.equal(context.compromised, false);
  return JSON.parse(JSON.stringify(result));
}

test('nested strong resolves its nearest block and field, with a short visible quote', () => {
  const block = element({ 'data-node-id': 'block-a', role: 'heading' }, 'Keep listening');
  const field = element({ 'data-field': 'subject' }, 'Keep listening', block);
  const strong = element({}, 'Keep\n listening', field);
  assert.deepEqual(probe('strong', [strong], [block]), {
    status: 'candidate', pageUrl: 'http://localhost:41700/lesson.html',
    nodeId: 'block-a', dataFieldAttribute: 'subject', ariaRole: 'heading', quote: 'Keep listening',
    occurrences: [{ dataFieldAttribute: null, ariaRole: 'heading', quote: 'Keep listening', ancestorNodeIds: [] }],
    ancestorNodeIds: [],
  });
});

for (const selector of [null, '', undefined]) test(`missing selector ${selector} requests fresh evidence`, () => {
  assert.equal(probe(selector, [], []).reason, 'missing-selector');
});

test('stale and ambiguous selectors refuse instead of picking the first element', () => {
  assert.deepEqual(probe('p', [], []).status, 'refused');
  assert.equal(probe('p', [], []).reason, 'stale-selector');
  assert.equal(probe('p', [element(), element()], []).reason, 'ambiguous-selector');
});

test('invalid selector refuses explicitly', () => {
  assert.equal(probe('[', new SyntaxError('Invalid selector'), []).reason, 'invalid-selector');
});

test('unexpected browser errors are not swallowed', () => {
  assert.throws(() => probe('p', new Error('Document unavailable'), []), /Document unavailable/);
});

test('duplicate wording in two blocks retains the selected ID', () => {
  const a = element({ 'data-node-id': 'block-a' }, 'Try again');
  const b = element({ 'data-node-id': 'block-b' }, 'Try again');
  const result = probe('#second', [b], [a, b]);
  assert.equal(result.nodeId, 'block-b');
  assert.equal(result.occurrences.length, 1);
});

test('legitimate repeated card projections are candidates with duplicate diagnostics', () => {
  const front = element({ 'data-node-id': 'card-a', role: 'group' }, 'Front');
  const back = element({ 'data-node-id': 'card-a', role: 'group' }, 'Back');
  const result = probe('#back', [back], [front, back]);
  assert.equal(result.status, 'candidate');
  assert.equal(result.nodeId, 'card-a');
  assert.deepEqual(result.occurrences.map(item => item.quote), ['Front', 'Back']);
});

test('runtime-only IDs stay untrusted candidates for Studio to resolve or refuse', () => {
  const runtime = element({ 'data-node-id': 'runtime-42' }, 'Heading');
  const result = probe('h1', [runtime], [runtime]);
  assert.equal(result.status, 'candidate');
  assert.equal(result.nodeId, 'runtime-42');
});

test('spoofed course HTML markers expose their enclosing ID and all occurrences', () => {
  const owner = element({ 'data-node-id': 'block-a' }, 'Authored HTML');
  const forged = element({ 'data-node-id': 'block-b', 'data-field': 'subject' }, 'Try again', owner);
  const real = element({ 'data-node-id': 'block-b' }, 'Try again');
  const result = probe('#forged', [forged], [owner, forged, real]);
  assert.equal(result.status, 'candidate');
  assert.deepEqual(result.ancestorNodeIds, ['block-a']);
  assert.deepEqual(result.occurrences.map(item => item.ancestorNodeIds), [['block-a'], []]);
  assert.equal(result.occurrences.length, 2);
});

test('a free region has no selector and cannot become a block address', () => {
  assert.equal(probe(null, [], []).reason, 'missing-selector');
});

test('an element without a block marker refuses', () => {
  assert.equal(probe('nav', [element()], []).reason, 'missing-node-id');
  const empty = element({ 'data-node-id': '' });
  assert.equal(probe('p', [empty], [empty]).reason, 'missing-node-id');
});

test('DOM probe compares executable-looking IDs as data', () => {
  const selector = 'p[data-label="\\\"); globalThis.compromised = true; //"]';
  const block = element({ 'data-node-id': 'id"] , body *' }, 'Quoted');
  assert.equal(probe(selector, [block], [block]).nodeId, 'id"] , body *');
});

test('field hints stop at the nearest owning marker', () => {
  const outside = element({ 'data-field': 'unrelated', role: 'navigation' });
  const block = element({ 'data-node-id': 'block-a' }, 'Text', outside);
  const result = probe('p', [block], [block]);
  assert.equal(result.dataFieldAttribute, null);
  assert.equal(result.ariaRole, null);
});

test('quotes are bounded and capability fragments never leave the page', () => {
  const block = element({ 'data-node-id': 'block-a' }, 'x'.repeat(250));
  const result = probe('p', [block], [block], 'http://localhost:41700/lesson.html#session=SECRET');
  assert.equal(result.quote.length, 200);
  assert.equal(result.pageUrl, 'http://localhost:41700/lesson.html');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

const resolver = join(repository, 'skills/studio-editor/scripts/resolve-annotation.mjs');

for (const selector of [
  'p[data-label="quoted"]',
  'p[data-label="\\backslash"]',
  '</script><script>globalThis.compromised = true</script>',
  '${globalThis.compromised = true}`$(echo unsafe)',
  '"); globalThis.compromised = true; //',
]) test(`packaged expression CLI round-trips selector as data: ${JSON.stringify(selector)}`, t => {
  const { root } = fixture(t);
  const input = join(root, 'selector.json');
  writeFileSync(input, JSON.stringify(selector));
  const cli = spawnSync(process.execPath, [resolver, '--expression', input], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  const block = element({ 'data-node-id': 'block-a' }, 'Selected');
  const selectors = [];
  const context = { compromised: false, document: {
    location: { href: 'http://localhost:41700/lesson.html#session=SECRET' },
    querySelectorAll(value) {
      selectors.push(value);
      return [block];
    },
  } };
  const result = runInNewContext(cli.stdout, context);
  assert.deepEqual(selectors, [selector, '[data-node-id]']);
  assert.equal(result.nodeId, 'block-a');
  assert.equal(context.compromised, false);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

for (const input of ['null', '""']) test(`packaged expression CLI preserves missing selector ${input}`, t => {
  const { root } = fixture(t);
  const path = join(root, 'selector.json');
  writeFileSync(path, input);
  const cli = spawnSync(process.execPath, [resolver, '--expression', path], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const result = runInNewContext(cli.stdout, { document: { location: { href: 'http://localhost/' } } });
  assert.equal(result.reason, 'missing-selector');
});

for (const input of ['{bad JSON', '{}', '[]', '42']) test(`expression CLI refuses invalid selector input ${input}`, t => {
  const { root } = fixture(t);
  const path = join(root, 'selector.json');
  writeFileSync(path, input);
  const cli = spawnSync(process.execPath, [resolver, '--expression', path], { encoding: 'utf8' });
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, '');
  assert.match(cli.stderr, /Cannot build annotation expression/);
});

for (const args of [[], ['--expression'], ['--other', 'missing.json'], ['--expression', 'missing.json', 'extra'], ['--expression', 'missing.json']]) {
  test(`expression CLI refuses missing file or unsupported arguments ${JSON.stringify(args)}`, () => {
    const cli = spawnSync(process.execPath, [resolver, ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /Cannot build annotation expression/);
  });
}

for (const args of [['--other'], ['--expression', 'extra']]) {
  test(`expression CLI rejects unsupported arguments even with a readable selector ${JSON.stringify(args)}`, t => {
    const { root } = fixture(t);
    const input = join(root, 'selector.json');
    writeFileSync(input, '\"p\"');
    const cliArgs = args.length === 1 ? [args[0], input] : [args[0], input, args[1]];
    const cli = spawnSync(process.execPath, [resolver, ...cliArgs], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /Cannot build annotation expression/);
  });
}

test('annotation CLI examples bind both dry run and write to UUID and whole-file revision', () => {
  const skill = readFileSync(join(repository, 'skills/studio-editor/SKILL.md'), 'utf8');
  const commands = skill.split('\n').filter(line => line.startsWith('praxity edit '));
  assert.equal(commands.length, 2, 'document both the dry run and guarded write');
  for (const command of commands) {
    const args = command.split(/\s+/);
    assert.equal(args[args.indexOf('--at') + 1], '<uuid>');
    assert.equal(args[args.indexOf('--expect-revision') + 1], '<fileRevision>');
    for (const forbidden of ['--find', '--page', '--block', '--line']) assert.equal(args.includes(forbidden), false);
  }
  assert.ok(commands[0].includes('--dry-run'));
  assert.equal(commands[1].includes('--dry-run'), false);
  assert.match(skill, /For annotation edits, forbid `--find`, `--page`, `--block` and `--line`/);
});
