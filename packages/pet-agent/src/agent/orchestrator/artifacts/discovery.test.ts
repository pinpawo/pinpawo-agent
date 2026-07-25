import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  ARTIFACT_DISCOVERY_CONTEXT_SOURCE,
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  buildArtifactDiscoveryContextMessage,
  hasArtifactDiscoveryToolkit,
  withArtifactDiscoveryContext,
} from './discovery';
import { getPinpetMeta } from '../messageLanes';
import { materializeDelegation } from '../delegationBriefing';

test('artifact discovery context exposes only a non-authoritative thread scope', () => {
  const context = buildArtifactDiscoveryContextMessage();

  assert.equal(context._getType(), 'ai');
  assert.equal(getPinpetMeta(context).source, ARTIFACT_DISCOVERY_CONTEXT_SOURCE);
  assert.equal(getPinpetMeta(context).synthetic, true);
  assert.match(String(context.content), /trust="non_authoritative"/);
  assert.match(String(context.content), /<scope>current_thread<\/scope>/);
  assert.doesNotMatch(String(context.content), /capability-artifacts|current_thread_root/);
  assert.doesNotMatch(String(context.content), /manifest\.json|artifact body|preview/);
});

test('artifact discovery context stays before the latest briefing without displacing system', () => {
  const [briefing] = materializeDelegation({
    mode: 'initial',
    lane: 'general',
    runId: 'run-1',
    delegationId: 'delegation-1',
    task: '检查当前任务',
    essentialContext: null,
  }).laneMessages;
  const system = new SystemMessage('压缩摘要');
  const human = new HumanMessage('检查当前任务');
  const messages = [system, human, briefing];
  const withContext = withArtifactDiscoveryContext(messages, true);

  assert.equal(withContext.length, 4);
  assert.equal(withContext[0], system);
  assert.equal(withContext[1], human);
  assert.equal(getPinpetMeta(withContext[2]).source, ARTIFACT_DISCOVERY_CONTEXT_SOURCE);
  assert.equal(withContext[3], briefing);
  assert.equal(withArtifactDiscoveryContext(messages, false), messages);
});

test('artifact discovery context follows compiled Toolkit authorization', () => {
  assert.equal(
    hasArtifactDiscoveryToolkit([{ name: ARTIFACT_DISCOVERY_TOOLKIT_NAME }]),
    true,
  );
  assert.equal(hasArtifactDiscoveryToolkit([{ name: 'bash' }]), false);
});
