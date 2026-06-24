import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCapabilityActionName,
  buildOrchestrationDecisionOutputInstruction,
  buildOrchestrationDecisionSchema,
  parseAction,
} from './schemas';

test('buildOrchestrationDecisionSchema rejects candidate names containing "."', () => {
  assert.throws(
    () => buildOrchestrationDecisionSchema({ capabilityCandidates: [{ name: 'foo.bar' }] }),
    /capability name must not contain '\.'/,
  );
});

test('buildOrchestrationDecisionSchema rejects duplicate candidate names', () => {
  assert.throws(
    () => buildOrchestrationDecisionSchema({
      capabilityCandidates: [{ name: 'browser' }, { name: 'browser' }],
    }),
    /duplicate capability name/,
  );
});

test('schema enum excludes capabilities not in candidates', () => {
  const schema = buildOrchestrationDecisionSchema({
    capabilityCandidates: [{ name: 'browser' }],
  });
  // unknown capability should fail to parse
  const bad = schema.safeParse({
    action: 'delegate_capability.daily_post',
    task: 't',
    context_summary: 'c',
  });
  assert.equal(bad.success, false);

  const good = schema.safeParse({
    action: 'delegate_capability.browser',
    task: 't',
    context_summary: 'c',
  });
  assert.equal(good.success, true);
});

test('schema enum allows static actions when no candidates', () => {
  const schema = buildOrchestrationDecisionSchema({ capabilityCandidates: [] });
  for (const action of ['finish', 'ask_user', 'delegate_general']) {
    assert.equal(schema.safeParse({ action }).success, true, `should accept ${action}`);
  }
  // legacy enum values are gone
  assert.equal(schema.safeParse({ action: 'human_review' }).success, false);
  assert.equal(schema.safeParse({ action: 'delegate_capability' }).success, false);
});

test('schema can exclude ask_user for user intent decisions', () => {
  const schema = buildOrchestrationDecisionSchema({
    capabilityCandidates: [{ name: 'browser' }],
    includeAskUser: false,
  });

  assert.equal(schema.safeParse({ action: 'finish' }).success, true);
  assert.equal(schema.safeParse({ action: 'delegate_general', task: 't' }).success, true);
  assert.equal(schema.safeParse({ action: 'delegate_capability.browser', task: 't' }).success, true);
  assert.equal(schema.safeParse({ action: 'ask_user', question: '补充什么？' }).success, false);
});

test('output instruction omits ask_user when disabled', () => {
  const instruction = buildOrchestrationDecisionOutputInstruction({ includeAskUser: false });

  assert.doesNotMatch(instruction, /ask_user/);
  assert.match(instruction, /需要直接向用户补充、澄清、确认/);
  assert.match(instruction, /question 本阶段不使用/);
});

test('schema strips legacy fields like capability/needs_human_review', () => {
  // schema currently strips unknowns silently (z.object default). The point is
  // these fields are gone — verify they don't appear on parsed output.
  const schema = buildOrchestrationDecisionSchema({
    capabilityCandidates: [{ name: 'browser' }],
  });
  const parsed = schema.safeParse({
    action: 'delegate_capability.browser',
    task: 't',
    context_summary: 'c',
    capability: 'browser',          // legacy field — should be ignored, not break
    needs_human_review: true,        // not in schema anymore
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal('capability' in parsed.data, false);
    assert.equal('needs_human_review' in parsed.data, false);
  }
});

test('parseAction splits delegate_capability.<name>', () => {
  assert.deepEqual(parseAction('delegate_capability.browser'), {
    kind: 'delegate_capability',
    capabilityName: 'browser',
  });
  assert.deepEqual(parseAction('delegate_general'), {
    kind: 'delegate_general',
    capabilityName: null,
  });
  assert.deepEqual(parseAction('finish'), { kind: 'finish', capabilityName: null });
  assert.deepEqual(parseAction('ask_user'), { kind: 'ask_user', capabilityName: null });
});

test('parseAction handles capability names containing dots in payload as a single suffix', () => {
  // Even though the schema rejects names with '.', parseAction still slices everything
  // after the first prefix occurrence. Documented for downstream guarantees.
  assert.deepEqual(parseAction('delegate_capability.foo.bar'), {
    kind: 'delegate_capability',
    capabilityName: 'foo.bar',
  });
});

test('buildCapabilityActionName composes the prefix correctly', () => {
  assert.equal(buildCapabilityActionName('browser'), 'delegate_capability.browser');
});
