import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { setPinpetMeta } from '../messageLanes';
import {
  CAPABILITY_PLANNER_MESSAGE_SOURCE,
  removeStaleCapabilityPlannerMessages,
  selectCapabilityPlannerMessages,
} from './messageContext';

function stampLane(
  message: AIMessage | ToolMessage,
  delegationId: string,
  runId = 'transcript-1',
) {
  setPinpetMeta(message, {
    lane: 'capability:general',
    runId,
    delegationId,
  });
  return message;
}

test('Planner message context selects canonical messages for each planning mode', () => {
  const mainRequest = new HumanMessage({
    content: [{ type: 'text', text: '检查这张图片并继续任务。' }, {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,planner-media' },
    }],
  });
  const toolCall = stampLane(new AIMessage({
    content: '',
    tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.ts' } }],
  }), 'delegation-1');
  const toolResult = stampLane(new ToolMessage({
    content: 'FILE_CONTENT',
    tool_call_id: 'call-1',
  }), 'delegation-1');
  const announce = stampLane(new AIMessage({
    id: 'announce-current',
    content: 'CURRENT_DELEGATION_ANNOUNCE',
  }), 'delegation-1');
  setPinpetMeta(announce, { isAnnounce: true });
  const otherLane = stampLane(new AIMessage('OTHER_DELEGATION_CONTENT'), 'delegation-2');
  const staleTranscript = stampLane(
    new AIMessage('STALE_TRANSCRIPT_CONTENT'),
    'delegation-1',
    'transcript-old',
  );
  const entryControlCall = new AIMessage({
    content: '',
    tool_calls: [{ id: 'plan-call', name: 'plan_request', args: {} }],
  });
  const priorPlannerMessage = new AIMessage('PRIOR_PLANNER_OBSERVATION');
  setPinpetMeta(priorPlannerMessage, {
    lane: 'orchestrator',
    source: CAPABILITY_PLANNER_MESSAGE_SOURCE,
    traceId: 'trace-1',
    registryDigest: 'digest-1',
  });
  const messages = [
    mainRequest,
    priorPlannerMessage,
    toolCall,
    toolResult,
    announce,
    otherLane,
    staleTranscript,
    entryControlCall,
  ];

  const entry = selectCapabilityPlannerMessages({
    mode: 'entry',
    messages,
    traceId: 'trace-1',
    registryDigest: 'digest-1',
  });
  assert.deepEqual(entry, [priorPlannerMessage, mainRequest]);

  const boundary = selectCapabilityPlannerMessages({
    mode: 'boundary',
    messages,
    traceId: 'trace-1',
    registryDigest: 'digest-1',
    lane: 'capability:general',
    transcriptRunId: 'transcript-1',
    delegationId: 'delegation-1',
    announceMessageId: 'announce-current',
  });
  assert.deepEqual(boundary, [
    priorPlannerMessage,
    announce,
  ]);
  assert.equal(boundary.includes(toolCall), false);
  assert.equal(boundary.includes(toolResult), false);
});

test('a fresh trace removes Planner messages owned by older traces', () => {
  const stale = new AIMessage({ id: 'planner-old', content: 'OLD_PLANNER_STATE' });
  setPinpetMeta(stale, {
    lane: 'orchestrator',
    source: CAPABILITY_PLANNER_MESSAGE_SOURCE,
    traceId: 'trace-old',
  });
  const current = new AIMessage({ id: 'planner-current', content: 'CURRENT_PLANNER_STATE' });
  setPinpetMeta(current, {
    lane: 'orchestrator',
    source: CAPABILITY_PLANNER_MESSAGE_SOURCE,
    traceId: 'trace-current',
  });

  const removals = removeStaleCapabilityPlannerMessages(
    [stale, current],
    'trace-current',
  );

  assert.deepEqual(removals.map((message) => message.id), ['planner-old']);
});
