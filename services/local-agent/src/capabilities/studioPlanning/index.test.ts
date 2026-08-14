import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAgentRegistry } from '@pinpawo/pet-agent';
import { createKanbanPlugin } from '@pinpawo-toolkit/studio-kanban';

import { loadStudioPlanningCapability, STUDIO_PLANNING_CAPABILITY_NAME } from './index';

test('the built-in capability declares the kanban toolkit', () => {
  const capability = loadStudioPlanningCapability();
  assert.ok(capability, 'built-in studio_planning must load');
  assert.equal(capability.name, STUDIO_PLANNING_CAPABILITY_NAME);
  // 这是它存在的全部理由:没有这条声明,pet 就拿不到 kanban_task_*。
  assert.deepEqual([...capability.uses], ['kanban']);
});

test('it compiles once the kanban plugin is present, exposing the task tools', () => {
  const capability = loadStudioPlanningCapability()!;
  const registry = compileAgentRegistry({
    toolkits: [createKanbanPlugin()],
    capabilities: [capability],
  });

  assert.equal(registry.unavailableCapabilities.length, 0);
  const compiled = registry.capabilities.find(
    (item) => item.capability.name === STUDIO_PLANNING_CAPABILITY_NAME,
  );
  assert.ok(compiled, 'studio_planning should compile against the kanban toolkit');

  const toolNames = compiled.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    'kanban_task_add',
    'kanban_task_block',
    'kanban_task_complete',
    'kanban_task_list',
  ]);
});

test('without the kanban toolkit it degrades to unavailable rather than throwing', () => {
  // chat 模式下 kanban 不在 toolkit 池里。这必须是安全的降级 —— 否则内置一个
  // studio 专用 Capability 会把普通对话一起弄挂。
  const capability = loadStudioPlanningCapability()!;
  const registry = compileAgentRegistry({ toolkits: [], capabilities: [capability] });

  assert.equal(registry.capabilities.length, 0);
  assert.equal(registry.unavailableCapabilities.length, 1);
  assert.equal(
    registry.unavailableCapabilities[0]?.capability.name,
    STUDIO_PLANNING_CAPABILITY_NAME,
  );
});
