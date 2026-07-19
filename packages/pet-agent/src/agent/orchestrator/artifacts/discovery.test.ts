import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  ARTIFACT_DISCOVERY_CONTEXT_SOURCE,
  ARTIFACT_DISCOVERY_LIST_DIR_TOOL_NAME,
  ARTIFACT_DISCOVERY_VIEW_FILE_CHUNK_TOOL_NAME,
  buildArtifactDiscoveryContextMessage,
  hasArtifactDiscoveryTools,
  withArtifactDiscoveryContext,
} from './discovery';
import { getPinpetMeta } from '../messageLanes';
import { materializeDelegation } from '../delegationBriefing';

test('artifact discovery context exposes only a non-authoritative scoped root', () => {
  const context = buildArtifactDiscoveryContextMessage(
    '/repo/.pinpawo/capability-artifacts/threads/thread%2Fone',
  );

  assert.ok(context);
  assert.equal(context._getType(), 'ai');
  assert.equal(getPinpetMeta(context).source, ARTIFACT_DISCOVERY_CONTEXT_SOURCE);
  assert.equal(getPinpetMeta(context).synthetic, true);
  assert.match(String(context.content), /trust="non_authoritative"/);
  assert.match(String(context.content), /current_thread_root/);
  assert.match(String(context.content), /thread%2Fone/);
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
  const withContext = withArtifactDiscoveryContext(messages, '/repo/.pinpawo/artifacts');

  assert.equal(withContext.length, 4);
  assert.equal(withContext[0], system);
  assert.equal(withContext[1], human);
  assert.equal(getPinpetMeta(withContext[2]).source, ARTIFACT_DISCOVERY_CONTEXT_SOURCE);
  assert.equal(withContext[3], briefing);
  assert.equal(withArtifactDiscoveryContext(messages, null), messages);
});

test('artifact discovery requires the selected scoped tool instances', () => {
  const scopedListDir = { name: ARTIFACT_DISCOVERY_LIST_DIR_TOOL_NAME };
  const scopedViewFileChunk = { name: ARTIFACT_DISCOVERY_VIEW_FILE_CHUNK_TOOL_NAME };
  const discoveryTools = [scopedListDir, scopedViewFileChunk];
  const foreignListDir = { name: ARTIFACT_DISCOVERY_LIST_DIR_TOOL_NAME };
  const foreignViewFileChunk = { name: ARTIFACT_DISCOVERY_VIEW_FILE_CHUNK_TOOL_NAME };

  assert.equal(hasArtifactDiscoveryTools(discoveryTools, discoveryTools), true);
  assert.equal(hasArtifactDiscoveryTools([scopedListDir], discoveryTools), false);
  assert.equal(
    hasArtifactDiscoveryTools([foreignListDir, foreignViewFileChunk], discoveryTools),
    false,
  );
});
