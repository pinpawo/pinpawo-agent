import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import {
  buildCapabilityArtifactContext,
  buildCapabilityDiscoveryRequestContext,
  buildDelegationOutcomeDecisionInput,
  buildPreparedRequestContext,
  buildSubagentAnnounceContext,
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

test('request contexts include bounded capability artifact refs', () => {
  const artifactContext = buildCapabilityArtifactContext([
    {
      id: 'artifact-1',
      threadId: 'thread-1',
      capabilityId: 'explore',
      delegationId: 'delegation-1',
      turnId: 'turn-1',
      kind: 'report',
      mimeType: 'text/markdown',
      uri: 'capability-artifact://thread/thread-1/delegation/delegation-1/artifact/artifact-1',
      title: 'Issue explore report',
      preview: '已确认 issue explore 的关键文件和下一步。',
      sizeBytes: 1200,
      createdAt: '2026-06-16T00:00:00.000Z',
    },
  ]);

  assert.match(artifactContext, /当前会话 capability artifacts/);
  assert.match(artifactContext, /Issue explore report/);
  assert.match(artifactContext, /capability-artifact:\/\/thread\/thread-1/);

  const requestContext = buildPreparedRequestContext({
    latestUserRequest: '继续刚才的探索',
    recentMessages: [],
    recentAnnounces: [],
    capabilityArtifacts: [{
      id: 'artifact-1',
      threadId: 'thread-1',
      capabilityId: 'explore',
      delegationId: 'delegation-1',
      turnId: 'turn-1',
      kind: 'report',
      mimeType: 'text/markdown',
      uri: 'capability-artifact://thread/thread-1/delegation/delegation-1/artifact/artifact-1',
      title: 'Issue explore report',
      preview: '已确认 issue explore 的关键文件和下一步。',
      sizeBytes: 1200,
      createdAt: '2026-06-16T00:00:00.000Z',
    }],
  });

  assert.match(requestContext, /当前会话 capability artifacts/);
  assert.match(requestContext, /继续刚才的探索/);
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
    capabilityArtifacts: [],
  });

  assert.doesNotMatch(input, /压缩任务上下文/);
  assert.match(input, /subagent announce/);
});

test('completed subagent announce context includes the full current result text', () => {
  const longResult = [
    '# Vibe Coding 模型排行榜',
    'A'.repeat(1400),
    'END_OF_FULL_RANKING_MARKER',
  ].join('\n\n');
  const context = buildSubagentAnnounceContext({
    lane: 'general',
    delegationId: 'task-1',
    task: '整理排行榜',
    announce: 'completed',
    text: longResult,
  }, 'natural');

  assert.match(context ?? '', /返回内容/);
  assert.match(context ?? '', /# Vibe Coding 模型排行榜/);
  assert.match(context ?? '', /END_OF_FULL_RANKING_MARKER/);
});
