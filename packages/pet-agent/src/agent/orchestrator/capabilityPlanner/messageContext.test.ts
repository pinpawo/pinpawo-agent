import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { setPinpetMeta } from '../messageLanes';
import { selectCapabilityPlannerMessages } from './messageContext';

function stampLane(
  message: AIMessage | ToolMessage,
  delegationId: string,
) {
  setPinpetMeta(message, {
    lane: 'capability:general',
    runId: 'transcript-1',
    delegationId,
  });
  return message;
}

test('Planner message context selects complete messages for each planning mode', () => {
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
  const announce = stampLane(new AIMessage('CURRENT_DELEGATION_ANNOUNCE'), 'delegation-1');
  const otherLane = stampLane(new AIMessage('OTHER_DELEGATION_CONTENT'), 'delegation-2');
  const entryControlCall = new AIMessage({
    content: '',
    tool_calls: [{ id: 'plan-call', name: 'plan_request', args: {} }],
  });
  const messages = [mainRequest, toolCall, toolResult, announce, otherLane, entryControlCall];

  const entry = selectCapabilityPlannerMessages({ mode: 'entry', messages });
  assert.equal(entry.scope, 'main_conversation');
  assert.deepEqual(entry.messages, [mainRequest]);

  const boundary = selectCapabilityPlannerMessages({
    mode: 'boundary',
    messages,
    lane: 'capability:general',
    transcriptRunId: 'transcript-1',
    delegationId: 'delegation-1',
  });
  assert.equal(boundary.scope, 'active_delegation');
  assert.deepEqual(boundary.messages, [mainRequest, toolCall, toolResult, announce]);
  assert.equal(boundary.messages[0], mainRequest, 'media content blocks stay intact');
});
