import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import test from 'node:test';
import { setAgentMessageMetadata } from '../../../../packages/pet-agent/src/agent/messages';
import { buildHostRuntimeConfig } from '../config/runtimeConfig';
import { FileSaver } from '../fileSaver';
import type { ServerDeps } from '../serverTypes';
import { createTestModelServerDeps } from '../testing/modelProfiles';
import { ServerTuiSessionService, readTuiCheckpointMessages } from './serverTuiSessions';
import { createEmptyTuiSessionState, createTuiSession, saveTuiSessionState } from './tuiSessionRegistry';

test('the current TUI namespace lists its own checkpoints without reading prior execution records', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinpawo-checkpoint-namespace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configured = buildHostRuntimeConfig(root);
  const runtimeConfig = {
    ...configured,
    sessionRoot: root,
    checkpointPath: join(root, basename(configured.checkpointPath)),
    tuiCheckpointPath: join(root, basename(configured.tuiCheckpointPath)),
    tuiSessionPath: join(root, basename(configured.tuiSessionPath)),
  };
  const priorState = createEmptyTuiSessionState();
  const priorSession = createTuiSession(priorState, 'pet-a', 'test-profile');
  const priorRegistryPath = join(root, 'tui-sessions-capability-v5.json');
  saveTuiSessionState(priorState, priorRegistryPath);
  const priorRegistry = await fs.readFile(priorRegistryPath);
  const metadata = { runId: 'run', taskId: 'task' };
  const execution = { planItemId: 'item', delegationId: 'delegation', capability: 'general',
    task: 'Prepare a report.', briefing: 'Prepare the report.' };
  const result = { status: 'returned', artifacts: [], delivery: {
    id: 'delivery', task: execution.task, text: 'Prior delivery.',
    scope: { ...metadata, delegationId: execution.delegationId, lane: 'capability:general' },
  } };
  const priorMessages = [
    setAgentMessageMetadata(new AIMessage({ content: '', tool_calls: [{
      id: 'call', name: 'delegate_capability', args: execution,
    }] }), metadata),
    setAgentMessageMetadata(new ToolMessage({ name: 'delegate_capability', tool_call_id: 'call',
      content: JSON.stringify(result), artifact: { kind: 'executed', execution, result },
    }), metadata),
    setAgentMessageMetadata(new AIMessage('Prior reply.'), metadata),
  ];
  assert.throws(() => readTuiCheckpointMessages(priorMessages), /Corrupted delegate_capability record/);

  async function writeMessages(saver: FileSaver, threadId: string, messages: BaseMessage[]) {
    await saver.put({ configurable: { thread_id: threadId } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(),
      channel_values: { messages }, channel_versions: { messages: 1 }, versions_seen: {},
    }, { source: 'input', step: 0, parents: {} });
  }
  const priorSaver = new FileSaver(join(root, 'checkpoints-tui-capability-v5.json'));
  await writeMessages(priorSaver, priorSession.threadId, priorMessages);
  const priorTuple = await priorSaver.getTuple({ configurable: { thread_id: priorSession.threadId } });
  const deps = { runtimeConfig, petId: 'pet-a', ...createTestModelServerDeps() } as ServerDeps;
  const options = {
    runtimeConfig, defaultModelProfileId: 'test-profile',
    loadContext: async () => ({ pet: { id: 'pet-a', name: 'Paw' } }),
  };
  const service = new ServerTuiSessionService(options);
  const fresh = await service.listSessions(deps);
  assert.equal(fresh.length, 1);
  assert.notEqual(fresh[0]?.id, priorSession.id);
  assert.equal(fresh[0]?.messageCount, 0);
  const current = service.getActiveSession('pet-a');
  await writeMessages(new FileSaver(runtimeConfig.tuiCheckpointPath), current.threadId, [
    new HumanMessage('Current request.'), new AIMessage('Current reply.'),
  ]);

  const restored = new ServerTuiSessionService(options);
  const listed = await restored.listSessions(deps);
  assert.deepEqual(listed.map(({ id, title, messageCount }) => ({ id, title, messageCount })), [
    { id: current.id, title: 'Current request.', messageCount: 2 },
  ]);
  assert.deepEqual((await restored.readActiveCheckpointPoint(deps)).messages.map(({ text }) => text), [
    'Current request.', 'Current reply.',
  ]);
  assert.deepEqual(await fs.readFile(priorRegistryPath), priorRegistry);
  assert.deepEqual(await priorSaver.getTuple({ configurable: { thread_id: priorSession.threadId } }), priorTuple);
});
