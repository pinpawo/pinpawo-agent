import assert from 'node:assert/strict';
import test from 'node:test';
import { copyDispatchPromptSections, withDispatchPromptSections } from './dispatchPromptContext';
import type { AgentChannelSetup } from '../agent/agentChannel';

test('dispatch prompt context accepts an escaped maximum Channel prompt and snapshots it', () => {
  const content = ']]>'.repeat(16_666).replaceAll(']]>', ']]]]><![CDATA[>');
  const supplied = [{ id: 'channel:context', owner: 'channel', content }];
  const copied = copyDispatchPromptSections(supplied);
  supplied[0]!.content = 'changed';
  assert.equal(copied[0]?.content, content);
  assert.ok(Object.isFrozen(copied) && Object.isFrozen(copied[0]));
});

test('dispatch prompt context rejects malformed or conflicting inputs', () => {
  for (const value of [null, {}, [{ id: '', content: 'x' }], [{ id: 'a', content: '' }],
    [{ id: 'a', content: 'x' }, { id: ' a ', content: 'y' }],
    [{ id: 'a', content: 'x', extra: true }], [{ id: 'a', content: 'x'.repeat(500_001) }]]) {
    assert.throws(() => copyDispatchPromptSections(value), /Invalid dispatch prompt/);
  }
});

test('dispatch prompt context appends without mutating or accumulating session state', () => {
  const base = { input: { context: { systemPromptSections: [{ id: 'pet:document', content: 'pet' }] } } } as AgentChannelSetup;
  const a = withDispatchPromptSections(base, [{ id: 'channel:context', content: 'A' }]);
  const b = withDispatchPromptSections(base, [{ id: 'channel:context', content: 'B' }]);
  assert.deepEqual(a.input.context?.systemPromptSections?.map((section) => section.content), ['pet', 'A']);
  assert.deepEqual(b.input.context?.systemPromptSections?.map((section) => section.content), ['pet', 'B']);
  assert.deepEqual(base.input.context?.systemPromptSections?.map((section) => section.content), ['pet']);
});
