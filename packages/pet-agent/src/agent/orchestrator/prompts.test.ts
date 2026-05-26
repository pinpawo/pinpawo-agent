import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import {
  buildCapabilityDiscoveryRequestContext,
  buildDelegationOutcomeDecisionInput,
  buildPreparedRequestContext,
} from './prompts';

function recentMessages(count: number) {
  return Array.from({ length: count }, (_, index) => new HumanMessage(`recent-${index}`));
}

test('start-loop router request context includes compaction summaries outside recent message window', () => {
  const requestContext = buildPreparedRequestContext({
    latestUserRequest: '继续推进',
    recentMessages: recentMessages(8),
    recentAnnounces: [],
    contextSummaries: ['更早任务摘要：已完成删除旧 pet-bot，PR 已打开，待修 router context。'],
  });

  assert.match(requestContext, /压缩任务上下文/);
  assert.match(requestContext, /更早任务摘要：已完成删除旧 pet-bot/);
  assert.match(requestContext, /recent-7/);
  assert.doesNotMatch(requestContext, /recent-0/);
});

test('capability discovery request context also receives compaction summaries', () => {
  const requestContext = buildCapabilityDiscoveryRequestContext({
    latestUserRequest: '帮我继续',
    recentMessages: recentMessages(1),
    recentAnnounces: [],
    contextSummaries: ['更早上下文：当前任务是修复 context compaction。'],
  });

  assert.match(requestContext, /压缩任务上下文/);
  assert.match(requestContext, /当前任务是修复 context compaction/);
});

test('loop-internal router input stays focused on current turn announce context', () => {
  const input = buildDelegationOutcomeDecisionInput({
    latestUserRequest: '继续推进',
    turnDelegationContext: '当前轮任务跟踪：\n- 所有已委派任务均为 completed。',
    subagentAnnounceContext: 'subagent announce：\n- 状态：completed',
  });

  assert.doesNotMatch(input, /压缩任务上下文/);
  assert.match(input, /subagent announce/);
});
