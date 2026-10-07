import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository } from './helpers.mjs';

// The reviewed conversion report supplies these expected bytes independently
// of the fixture. Keep identity and narration with the grammar 4 lesson.
const approved = {
  '.praxity/identity/course.json': '830a06ef10fbc961560cd412ecd47368fbe3d78833273174120163cf1a985527',
  '.praxity/identity/lessons/d342e19e-bfdf-4532-a8fe-3da35b940412.json': '1524b82ecf0b49889fc724f9c8763aebf4979337ef5db707f479ae851b400aa0',
  '.praxity/identity/snapshots/16fecd4389b67b45d09982d726cf383af961053b2fa773172645e67520809a98.json': '16fecd4389b67b45d09982d726cf383af961053b2fa773172645e67520809a98',
  '.praxity/review/accepted.json': '488641d2710f9ec0d194def5226353f14a889f4e2cd14743a557b849987729aa',
  'course.yaml': '22879972a10de0102026389204e0384d8e3c460056c2d43d98da07fb5bc7aabe',
  'narration-review.md': '7d26a659b8d719480f59bf94b24617173322c42b3c3cd3827d1d942e52ca90c7',
  'narration.yaml': 'f0aaffc6e6898dc0fe2ea394c51b58ac4dffc15cf4f6501093be18d92685edd8',
  'welcome.prax': 'def80bdf3dc338422d97e028740c150bf3af5cd862dcd6f51ee6cdf1506b78e8',
};

test('Studio smoke course retains the approved grammar 4 payload', () => {
  for (const [path, expected] of Object.entries(approved)) {
    const actual = createHash('sha256').update(readFileSync(join(repository, 'fixtures/course', path))).digest('hex');
    assert.equal(actual, expected, path);
  }
});
