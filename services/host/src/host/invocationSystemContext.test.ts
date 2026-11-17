import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotInvocationContext, snapshotInvocationContextResult, snapshotInvocationSections, withInvocationContext } from './invocationSystemContext';
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
  const a = withInvocationContext(base, { systemPromptSections: [{ id: 'channel:context', content: 'A' }] });
  const b = withInvocationContext(base, { systemPromptSections: [{ id: 'channel:context', content: 'B' }] });
  assert.deepEqual(a.input.context?.systemPromptSections?.map((section) => section.content), ['pet', 'A']);
  assert.deepEqual(b.input.context?.systemPromptSections?.map((section) => section.content), ['pet', 'B']);
  assert.deepEqual(base.input.context?.systemPromptSections?.map((section) => section.content), ['pet']);
});


test('invocation hints are snapshotted separately and do not accumulate in prompts or history', () => {
  const supplied = { systemPromptSections: [{ id: 'scope', content: 'scope marker' }],
    hint: { source: 'domain', instruction: '  original instruction  ', focus: 'original focus' } };
  const snapshot = snapshotInvocationContext(supplied);
  supplied.hint.instruction = 'changed';
  supplied.hint.focus = 'changed';
  supplied.systemPromptSections[0]!.content = 'changed';
  assert.deepEqual(snapshot.hint, { source: 'domain', instruction: '  original instruction  ', focus: 'original focus' });
  assert.equal(snapshot.systemPromptSections?.[0]?.content, 'scope marker');
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.hint));
  const base = { input: { messages: ['original history'], context: { systemPromptSections: [{ id: 'identity', content: 'identity marker' }] } } } as unknown as AgentChannelSetup;
  const current = withInvocationContext(base, snapshot);
  assert.deepEqual(current.input.context?.hint, snapshot.hint);
  assert.deepEqual(current.input.context?.systemPromptSections?.map(section => section.content), ['identity marker', 'scope marker']);
  assert.equal(current.input.messages, base.input.messages);
  assert.equal(Object.hasOwn(base.input.context!, 'hint'), false);
  const next = withInvocationContext(base, {});
  assert.equal(next, base);
  assert.equal(Object.hasOwn(next.input.context!, 'hint'), false);
  const noOriginalHint = withInvocationContext(current, {});
  assert.equal(Object.hasOwn(noOriginalHint.input.context!, 'hint'), false);
});

test('provider results preserve legacy array shape and reject malformed hint payloads', () => {
  const legacy = snapshotInvocationContextResult([{ id: 'legacy', content: 'marker' }]);
  assert.ok(Array.isArray(legacy));
  assert.ok(Object.isFrozen(legacy));
  assert.equal(snapshotInvocationContextResult(undefined), undefined);
  assert.deepEqual(snapshotInvocationContext({}), {});
  for (const value of [null, { extra: true }, { hint: null }, { hint: { source: '', instruction: 'x' } },
    { hint: { source: 'domain', instruction: '  ' } }, { hint: { source: 'domain', instruction: 'x', goal: 'forged' } }]) {
    assert.throws(() => snapshotInvocationContext(value));
  }
});
