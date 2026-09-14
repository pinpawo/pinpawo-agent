import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { compileAgentRegistry } from '@pinpawo/pet-agent';
import { createKanbanPlugin } from '@pinpawo-plugin/kanban';
import { createTriggerPlugin } from '@pinpawo-plugin/trigger';
import { createStudio, type StudioPetBinding } from '@pinpawo/studio';
import { loadCapabilityDirectory } from 'pinpawo/host-runtime';
import { createBashToolkit, createGitToolkit } from '../../../services/local-agent/src/toolkits/local';

for (const [petId, workName] of [['executor', 'studio_execution'], ['reviewer', 'studio_review']]) {
  test(`${petId} works without completing Kanban; reporting publishes the final result to Wiki`, async (t) => {
    const kanban = createKanbanPlugin({ httpRoute: false });
    const received: string[] = [];
    const binding = (id: string): StudioPetBinding => ({
      registration: { petId: id, name: id },
      dispatch: {
        getQueueSnapshot: () => ({ state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => undefined,
        onDispatchLifecycle: () => () => undefined,
        dispatch: async ({ request }) => { if (id === 'wiki') received.push(request); },
      },
    });
    const studio = await createStudio({
      studioId: 'reporting-e2e', entryPetId: petId,
      pets: [binding(petId), binding('wiki')],
      plugins: [kanban, createTriggerPlugin({ triggers: [{
        triggerId: 'wiki-on-task-done', petId: 'wiki',
        request: { template: 'Update knowledge for {{payload.taskId}}', context: ['payload.note'] },
        source: { kind: 'studio_event', eventSource: 'kanban', type: 'task.done' },
      }] })],
    });
    t.after(() => studio.shutdown());
    const loaded = await loadCapabilityDirectory(path.resolve(
      import.meta.dirname, `../../../packages/studio/templates/default/pets/${petId}/capabilities`,
    ));
    const registry = compileAgentRegistry({
      capabilities: loaded.map(({ capability }) => capability),
      toolkits: [...kanban.toolkits, createBashToolkit(), createGitToolkit()],
    });
    assert.deepEqual(registry.unavailableCapabilities, []);
    const work = registry.capabilities.find(({ capability }) => capability.name === workName)!;
    const reporting = registry.capabilities.find(({ capability }) => capability.name === 'studio_reporting')!;
    assert.ok(work);
    assert.ok(reporting);
    assert.ok(work.toolNames.includes('view_file_chunk'));
    assert.ok(work.toolNames.includes('kanban_task_start'));
    assert.ok(!work.toolNames.includes('kanban_task_complete'));
    assert.ok(!work.toolNames.includes('kanban_task_block'));
    assert.deepEqual([...reporting.toolNames].sort(), ['kanban_task_block', 'kanban_task_complete', 'kanban_task_list']);

    const taskId = (await kanban.service.createTask({ title: 'Check evidence', detail: 'Report the verified result.' })).task.taskId;
    await kanban.service.assignTask(taskId, petId);
    await work.tools.find(({ name }) => name === 'kanban_task_start')!.invoke({ taskId });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await kanban.service.getTask(taskId))?.status, 'doing');
    assert.equal(received.length, 0, 'Starting work must not trigger Wiki');

    // A supplemented delivery remains local until the reporting capability is selected.
    const result = 'Final evidence: corrected reference and validation result.';
    await reporting.tools.find(({ name }) => name === 'kanban_task_complete')!.invoke({ taskId, result });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await kanban.service.getTask(taskId))?.note, result);
    assert.equal((await kanban.service.getTask(taskId))?.status, 'done');
    assert.equal(received.length, 1);
    assert.ok(received[0]?.includes(result), 'Wiki must receive the submitted final evidence');

    const blockedId = (await kanban.service.createTask({ title: 'Unavailable evidence', detail: 'Requires missing access.' })).task.taskId;
    await kanban.service.assignTask(blockedId, petId);
    const reason = 'Required source is unavailable; provide access to continue.';
    await reporting.tools.find(({ name }) => name === 'kanban_task_block')!.invoke({ taskId: blockedId, reason });
    assert.equal((await kanban.service.getTask(blockedId))?.status, 'blocked');
    assert.equal((await kanban.service.getTask(blockedId))?.note, reason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1, 'Reporting a block must not trigger Wiki');
  });
}
