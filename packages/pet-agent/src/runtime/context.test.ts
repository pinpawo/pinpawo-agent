import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { agentInvocationHintSchema } from '../types/invocationHint';
import { getAgentRuntimeContext } from './context';

test('invocation hints preserve source fields in an immutable snapshot without a configurable fallback', () => {
  const hint = { source: randomUUID(), instruction: ` ${randomUUID()}\n`, focus: randomUUID() };
  const before = { ...hint };
  const context = getAgentRuntimeContext({ context: { hint } });
  assert.deepEqual(context.hint, before);
  assert.equal(Object.isFrozen(context.hint), true);
  hint.instruction = randomUUID();
  assert.deepEqual(context.hint, before);
  const defaults = { workdir: null, systemPromptSections: [] };
  for (const config of [undefined, { context: {} }, { context: { hint: undefined } }, { configurable: { hint } }]) {
    assert.deepEqual(getAgentRuntimeContext(config), defaults);
    assert.equal('hint' in getAgentRuntimeContext(config), false);
  }
});

test('hint validation rejects missing provenance, blank fields and unknown fields', () => {
  const hint = { source: randomUUID(), instruction: randomUUID() };
  assert.deepEqual(agentInvocationHintSchema.parse(hint), hint);
  for (const invalid of [null, {}, { instruction: hint.instruction }, { source: hint.source },
    { ...hint, source: ' ' }, { ...hint, instruction: '\n' }, { ...hint, focus: ' ' },
    { ...hint, focus: false }, { ...hint, goal: randomUUID() }]) {
    assert.equal(agentInvocationHintSchema.safeParse(invalid).success, false);
    assert.throws(() => getAgentRuntimeContext({ context: { hint: invalid } }));
  }
});
