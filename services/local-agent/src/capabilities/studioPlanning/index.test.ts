import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAgentRegistry } from '@pinpawo/pet-agent';
import { createKanbanPlugin } from '@pinpawo-toolkit/studio-kanban';

import { LocalAgentCapabilityRegistry } from '../../localAgentCapabilityRegistry';
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

test('it stays out of the default registry so chat is untouched', async () => {
  // 它声明 uses: ['kanban'],而 kanban 只在 studio 装配时注入。放进默认
  // registry 会让**每个普通 chat 会话**都打一条 "unavailable" 警告 ——
  // 稳定的 chat 路径不该因为 studio 的改动而变。
  // getLocalCapabilities() 正是 chat handler 取用的那个列表。
  const registry = new LocalAgentCapabilityRegistry();
  await registry.load();

  assert.equal(
    registry.getLocalCapabilities().some((item) => item.name === STUDIO_PLANNING_CAPABILITY_NAME),
    false,
    'studio_planning must be provided by the studio assembly, not the default registry',
  );
});
