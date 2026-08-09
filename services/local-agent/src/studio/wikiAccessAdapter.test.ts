import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import type {
  AgentActor,
  AgentModels,
  NamedStructuredTool,
  OrchestratorGraph,
} from '@pinpawo/pet-agent';
import { createFileWikiAccess } from '@pinpawo-toolkit/studio-kanban';

import { createPetAgentRuntime } from './createPetAgentRuntime';

// adapter 把 PetAgentRuntime port 接到 LangGraph 执行路径上;wiki 装配是
// 这条接线的一部分,因此测试跟着 adapter 走,而不是留在 kanban。

function fakeModels(): AgentModels {
  // graph 已被 stub,实际不会用到 models。
  return {} as AgentModels;
}

function fakeActor(): AgentActor {
  return {
    petId: 'p1',
    userId: 'u1',
    name: 'Test Pet',
    personality: null,
    stage: null,
    species: null,
  };
}

function mockTool<const TName extends string>(name: TName): NamedStructuredTool<TName> {
  return tool(async () => 'ok', {
    name,
    description: `${name} test tool`,
    schema: z.object({}),
  }) as NamedStructuredTool<TName>;
}

function makeStubGraph(responses: unknown[]): {
  graph: OrchestratorGraph;
  calls: { input: unknown; options?: unknown }[];
} {
  const calls: { input: unknown; options?: unknown }[] = [];
  let i = 0;
  const graph = {
    invoke: async (input: unknown, options?: unknown) => {
      calls.push({ input, options });
      const r = responses[i++];
      if (r === undefined) {
        throw new Error(`graph stub exhausted at call #${i}`);
      }
      return r;
    },
  } as unknown as OrchestratorGraph;
  return { graph, calls };
}

type StubConfigurable = {
  configurable?: {
    registry?: {
      toolkits?: Array<{
        name?: string;
        tools?: Array<{ tool?: { name?: string }; operation?: { title?: string } }>;
      }>;
      capabilities?: Array<{
        capability?: { name?: string };
        toolkits?: Array<{ name?: string }>;
      }>;
    };
  };
};

test('file wiki access installs wiki_read tooling into a pet invoke', async () => {
  const { graph, calls } = makeStubGraph([{ messages: [new AIMessage('done')] }]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
    wikiAccess: createFileWikiAccess(),
    toolkits: [{
      name: 'plugin_toolkit',
      description: 'plugin toolkit',
      tools: [{ tool: mockTool('plugin_tool'), operation: { title: 'Plugin Tool' } }],
    }],
  });

  const result = await runtime.invoke({
    brief: 'read wiki',
    wikiRoot: '/tmp/pinpawo-test-wiki',
    toolkits: [{
      name: 'invoke_toolkit',
      description: 'invoke toolkit',
      tools: [{ tool: mockTool('invoke_tool'), operation: { title: 'Invoke Tool' } }],
    }],
  });

  assert.equal(result.reply, 'done');
  const configurable = (calls[0]?.options as StubConfigurable | undefined)?.configurable;
  assert.ok(configurable, 'graph should receive configurable');

  const registry = configurable.registry;
  const wikiToolkit = registry?.toolkits?.find((toolkit) => toolkit.name === 'wiki_read');
  assert.ok(wikiToolkit, 'wikiRoot plus wikiAccess should install wiki_read as a toolkit');

  // 注入 wiki 不应挤掉调用方自己的 toolkit。
  const pluginToolkit = registry?.toolkits?.find((toolkit) => toolkit.name === 'plugin_toolkit');
  const invokeToolkit = registry?.toolkits?.find((toolkit) => toolkit.name === 'invoke_toolkit');
  assert.equal(pluginToolkit?.tools?.[0]?.operation?.title, 'Plugin Tool');
  assert.equal(invokeToolkit?.tools?.[0]?.operation?.title, 'Invoke Tool');

  assert.deepEqual(
    registry?.capabilities
      ?.find(({ capability }) => capability?.name === 'wiki')
      ?.toolkits?.map((toolkit) => toolkit.name),
    ['wiki_read'],
  );
  assert.equal(
    wikiToolkit.tools?.find((item) => item.tool?.name === 'wiki_read_cat')?.operation?.title,
    '读取知识库文件',
  );
  assert.equal(
    wikiToolkit.tools?.find((item) => item.tool?.name === 'wiki_read_grep')?.operation?.title,
    '搜索知识库内容',
  );
});

test('a pet invoke without wiki access installs no wiki tooling', async () => {
  // 编排核心不再硬编码 wiki:不注入实现就不该出现 wiki_read。
  const { graph, calls } = makeStubGraph([{ messages: [new AIMessage('done')] }]);

  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
  });

  await runtime.invoke({ brief: 'no wiki', wikiRoot: '/tmp/pinpawo-test-wiki' });

  const configurable = (calls[0]?.options as StubConfigurable | undefined)?.configurable;
  assert.equal(
    configurable?.registry?.toolkits?.find((toolkit) => toolkit.name === 'wiki_read'),
    undefined,
  );
});

