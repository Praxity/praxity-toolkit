// Self-contained so the host can send this function to the preview's main frame.
export function resolveAnnotationSelector(selector) {
  const pageUrl = document.location.href.split('#')[0];
  const refuse = reason => ({ status: 'refused', reason, pageUrl });
  if (typeof selector !== 'string' || !selector.trim()) return refuse('missing-selector');
  let matches;
  try {
    matches = document.querySelectorAll(selector);
  } catch (error) {
    if (error.name === 'SyntaxError') return refuse('invalid-selector');
    throw error;
  }
  if (matches.length !== 1) return refuse(matches.length ? 'ambiguous-selector' : 'stale-selector');
  const selected = matches[0];
  const owner = selected.closest('[data-node-id]');
  const nodeId = owner?.getAttribute('data-node-id');
  if (!nodeId) return refuse('missing-node-id');
  const quote = element => (element.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const ancestorNodeIds = element => {
    const ids = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const id = parent.getAttribute('data-node-id');
      if (id !== null) ids.push(id);
    }
    return ids;
  };
  const nearestAttribute = name => {
    for (let element = selected; element; element = element.parentElement) {
      const value = element.getAttribute(name);
      if (value !== null) return value;
      if (element === owner) break;
    }
    return null;
  };
  // Compare attribute values as data. An ID is not a CSS selector or authority.
  const occurrences = Array.from(document.querySelectorAll('[data-node-id]'))
    .filter(element => element.getAttribute('data-node-id') === nodeId)
    .map(element => ({
      field: element.getAttribute('data-field'),
      role: element.getAttribute('role'),
      quote: quote(element),
      ancestorNodeIds: ancestorNodeIds(element),
    }));
  return {
    status: 'candidate', pageUrl, nodeId,
    field: nearestAttribute('data-field'), role: nearestAttribute('role'),
    quote: quote(selected), occurrences, ancestorNodeIds: ancestorNodeIds(owner),
  };
}
