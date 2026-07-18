import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import {
  ARTIFACT_DISCOVERY_CONTEXT_SOURCE,
  buildArtifactDiscoveryContextMessage,
  hasArtifactDiscoveryTools,
  withArtifactDiscoveryContext,
} from './discovery';
import { getPinpetMeta } from '../messageLanes';

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

test('artifact discovery context is prepended only when a root is configured', () => {
  const messages = [new HumanMessage('检查当前任务')];
  const withContext = withArtifactDiscoveryContext(messages, '/repo/.pinpawo/artifacts');

  assert.equal(withContext.length, 2);
  assert.equal(getPinpetMeta(withContext[0]).source, ARTIFACT_DISCOVERY_CONTEXT_SOURCE);
  assert.equal(withContext[1], messages[0]);
  assert.equal(withArtifactDiscoveryContext(messages, null), messages);
});

test('artifact discovery requires both read-only file tools', () => {
  const listDir = { name: 'list_dir' };
  const viewFileChunk = { name: 'view_file_chunk' };

  assert.equal(hasArtifactDiscoveryTools([listDir, viewFileChunk]), true);
  assert.equal(hasArtifactDiscoveryTools([listDir]), false);
  assert.equal(hasArtifactDiscoveryTools([viewFileChunk]), false);
});
