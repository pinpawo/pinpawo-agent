import assert from 'node:assert/strict';
import test from 'node:test';
import { assertToolDeliverables, createToolDeliverables } from './index';

test('tool deliverables preserve declared references and unrelated artifact metadata', () => {
  const deliverables = [
    { uri: 'artifact://workspace/report', title: 'Report' },
    { uri: 'https://example.com/pull/1', source: 'repository' },
    { uri: ' custom:reference ', title: '' },
  ];
  assert.deepEqual(createToolDeliverables(deliverables), { deliverables });
  assert.deepEqual(createToolDeliverables([]), { deliverables: [] });
  const artifact = { deliverables, otherMetadata: { source: 'tool' } };
  assert.doesNotThrow(() => assertToolDeliverables(artifact));
  assert.deepEqual(artifact, { deliverables, otherMetadata: { source: 'tool' } });
});

test('tool deliverables reject malformed declarations before a tool returns', () => {
  for (const artifact of [
    null, {}, { deliverables: null }, { deliverables: {} },
    { deliverables: [null] }, { deliverables: [{}] },
    { deliverables: [{ uri: 123 }] }, { deliverables: [{ uri: 'x', title: 1 }] },
    { deliverables: [{ uri: '' }] }, { deliverables: [{ uri: ' \t\n' }] },
    { deliverables: new Array(1) },
  ]) {
    assert.throws(() => assertToolDeliverables(artifact), TypeError);
  }
  assert.throws(() => createToolDeliverables([{ uri: null }]), TypeError);
});
