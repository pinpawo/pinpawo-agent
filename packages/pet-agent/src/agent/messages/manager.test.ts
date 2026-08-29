import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createAgentMessageManager } from './manager';
import { setAgentMessageDelegationScope, setAgentMessageMetadata } from './metadata';

const activeScope = {
  lane: 'capability:general' as const,
  transcriptRunId: 'transcript-1',
  delegationId: 'delegation-1',
};

test('delegation view preserves canonical chronology and excludes every other lane', () => {
  const mainBefore = new HumanMessage({ id: 'main-before', content: 'start' });
  const activeFirst = setAgentMessageDelegationScope(
    new AIMessage({ id: 'active-first', content: 'work' }),
    activeScope,
  );
  const mainAfter = new HumanMessage({ id: 'main-after', content: 'guidance' });
  const other = setAgentMessageDelegationScope(
    new AIMessage({ id: 'other', content: 'private' }),
    {
      lane: 'capability:general',
      transcriptRunId: 'transcript-2',
      delegationId: 'delegation-2',
    },
  );

  const view = createAgentMessageManager([
    mainBefore,
    activeFirst,
    other,
    mainAfter,
  ]).delegation({
    name: 'capability',
    audience: 'capability:general',
    scope: activeScope,
  });

  assert.deepEqual(view.messages, [mainBefore, activeFirst, mainAfter]);
  assert.equal(view.manifest.sources[0]?.selectedCount, 2);
  assert.equal(view.manifest.sources[1]?.selectedCount, 1);
  assert.equal(view.manifest.excludedCanonicalCount, 1);
  assert.deepEqual(view.manifest.excludedItems, [{
    messageId: 'other',
    sourceId: null,
    lane: 'capability:general',
    canonical: true,
    reason: 'scope_mismatch',
  }]);
});

test('boundary view selects only Announces from the exact active delegation', () => {
  const main = new HumanMessage({ id: 'main', content: 'goal' });
  const raw = setAgentMessageDelegationScope(
    new AIMessage({ id: 'raw', content: 'raw transcript' }),
    activeScope,
  );
  const announce = setAgentMessageMetadata(setAgentMessageDelegationScope(
    new AIMessage({ id: 'announce', content: 'result' }),
    activeScope,
  ), { isAnnounce: true });
  const overlay = new HumanMessage({ id: 'overlay', content: 'boundary' });

  const view = createAgentMessageManager([main, raw, announce]).delegation({
    name: 'planner_boundary',
    audience: 'capability_planner',
    scope: activeScope,
    visibility: 'announces_only',
    overlays: [{ id: 'boundary', messages: [overlay] }],
  });

  assert.deepEqual(view.messages, [main, announce, overlay]);
  assert.deepEqual(view.messagesBySource, {
    main: [main],
    delegation: [announce],
    boundary: [overlay],
  });
  assert.deepEqual(view.manifest.items.map((item) => item.sourceId), [
    'main',
    'delegation',
    'boundary',
  ]);
  assert.equal(view.manifest.overlayCount, 1);
});

test('view projection is ephemeral and tool protocol removals are observable', () => {
  const dangling = new AIMessage({
    id: 'dangling',
    content: '',
    tool_calls: [{ id: 'call-1', name: 'read', args: {} }],
  });
  const orphan = new ToolMessage({
    id: 'orphan',
    content: 'orphan',
    tool_call_id: 'missing',
  });
  const accepted = new AIMessage({ id: 'accepted', content: 'canonical' });
  const projected = new AIMessage({ id: 'accepted', content: 'projected' });

  const view = createAgentMessageManager([dangling, orphan, accepted]).main({
    name: 'entry',
    audience: 'entry_answer',
    projector: (message) => message === accepted ? projected : message,
  });

  assert.deepEqual(view.messages, [projected]);
  assert.equal(accepted.text, 'canonical');
  assert.deepEqual(view.manifest.toolProtocolRemovedMessageIds, ['dangling', 'orphan']);
  assert.deepEqual(view.manifest.excludedItems.map((item) => item.reason), [
    'tool_protocol',
    'tool_protocol',
  ]);
  assert.equal(view.manifest.items[0]?.projected, true);
});

test('view source ids are unique across canonical sources and overlays', () => {
  assert.throws(
    () => createAgentMessageManager([]).main({
      name: 'invalid',
      audience: 'test',
      overlays: [{ id: 'main', messages: [] }],
    }),
    /source ids must be unique/,
  );
});
