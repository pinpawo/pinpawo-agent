import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotInvocationSections, withInvocationSections } from './invocationSystemContext';
import type { AgentChannelSetup } from '../agent/agentChannel';

test('invocation prompt context accepts an escaped maximum Channel prompt and snapshots it', () => {
  const content = ']]>'.repeat(16_666).replaceAll(']]>', ']]]]><![CDATA[>');
  const supplied = [{ id: 'channel:context', owner: 'channel', content }];
  const copied = snapshotInvocationSections(supplied);
  supplied[0]!.content = 'changed';
  assert.equal(copied[0]?.content, content);
  assert.ok(Object.isFrozen(copied) && Object.isFrozen(copied[0]));
});

test('invocation prompt context rejects malformed or conflicting inputs', () => {
  for (const value of [null, {}, [{ id: '', content: 'x' }], [{ id: 'a', content: '' }],
    [{ id: 'a', content: 'x' }, { id: ' a ', content: 'y' }],
    [{ id: 'a', content: 'x', extra: true }], [{ id: 'a', content: 'x'.repeat(500_001) }],
    Array.from({ length: 33 }, (_, index) => ({ id: `section:${index}`, content: 'x' }))]) {
    assert.throws(() => snapshotInvocationSections(value), /Invalid invocation prompt/);
  }
});

test('invocation prompt context appends without mutating or accumulating session state', () => {
  const base = { input: { context: { systemPromptSections: [{ id: 'pet:document', content: 'pet' }] } } } as unknown as AgentChannelSetup;
  const a = withInvocationSections(base, [{ id: 'channel:context', content: 'A' }]);
  const b = withInvocationSections(base, [{ id: 'channel:context', content: 'B' }]);
  assert.deepEqual(a.input.context?.systemPromptSections?.map((section) => section.content), ['pet', 'A']);
  assert.deepEqual(b.input.context?.systemPromptSections?.map((section) => section.content), ['pet', 'B']);
  assert.deepEqual(base.input.context?.systemPromptSections?.map((section) => section.content), ['pet']);
});
