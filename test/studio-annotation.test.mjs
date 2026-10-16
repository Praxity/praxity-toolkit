import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
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
    nodeId: 'block-a', field: 'subject', role: 'heading', quote: 'Keep listening',
    occurrences: [{ field: null, role: 'heading', quote: 'Keep listening', ancestorNodeIds: [] }],
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
  assert.equal(probe('h1', [runtime], [runtime]).status, 'candidate');
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

test('selectors and IDs containing executable-looking text remain data', () => {
  const selector = 'p[data-label="\\\"); globalThis.compromised = true; //"]';
  const block = element({ 'data-node-id': 'id"] , body *' }, 'Quoted');
  assert.equal(probe(selector, [block], [block]).nodeId, 'id"] , body *');
});

test('field hints stop at the nearest owning marker', () => {
  const outside = element({ 'data-field': 'unrelated', role: 'navigation' });
  const block = element({ 'data-node-id': 'block-a' }, 'Text', outside);
  const result = probe('p', [block], [block]);
  assert.equal(result.field, null);
  assert.equal(result.role, null);
});

test('quotes are bounded and capability fragments never leave the page', () => {
  const block = element({ 'data-node-id': 'block-a' }, 'x'.repeat(250));
  const result = probe('p', [block], [block], 'http://localhost:41700/lesson.html#session=SECRET');
  assert.equal(result.quote.length, 200);
  assert.equal(result.pageUrl, 'http://localhost:41700/lesson.html');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
