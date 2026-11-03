import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToolDeliverables, createToolDeliverables, readToolDeliverables } from './deliverable';

test('tool declarations preserve references and other tool payload data', () => {
  const reference = { uri: 'https://example.test/pr/1', title: 'Review', source: { revision: 3 } };
  const artifact = { report: 'done', ...createToolDeliverables([reference]) };
  assert.deepEqual(readToolDeliverables(artifact), [reference]);
  assert.strictEqual(readToolDeliverables(artifact)[0], reference);
  assert.equal(artifact.report, 'done');
  assert.deepEqual(JSON.parse(JSON.stringify(artifact)).deliverables, [reference]);
});

test('ordinary tool artifacts do not declare references implicitly', () => {
  for (const artifact of [undefined, null, 'https://example.test', [], { uri: 'artifact://space/thread/id/file' }]) {
    assert.deepEqual(readToolDeliverables(artifact), []);
  }
});

test('a present but malformed declaration fails rather than disappearing', () => {
  for (const deliverables of [null, {}, 'file', [null], [{ uri: '' }], [{ uri: '  ' }],
    [{ uri: 12 }], [{ uri: 'https://example.test', title: 12 }]]) {
    assert.throws(() => readToolDeliverables({ deliverables }), TypeError);
  }
  assert.throws(() => assertToolDeliverables({}), TypeError);
  assert.deepEqual(createToolDeliverables([]), { deliverables: [] });
});
