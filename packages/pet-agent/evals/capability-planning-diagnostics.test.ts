import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createCapabilityDetailsDiagnosticsCollector } from './capability-planning-diagnostics.ts';

test('capability search diagnostics report traced calls, rounds, queries, and results', async () => {
  const collector = createCapabilityDetailsDiagnosticsCollector();
  await collector.callback.handleToolStart?.(
    { name: 'capability_details' } as never,
    JSON.stringify({ names: ['kanban', 'task registration'] }),
    'search-run-1',
    'supervisor-run',
    [],
    {},
    'capability_details',
  );
  await collector.callback.handleToolEnd?.(new Command({
    update: {
      messages: [new ToolMessage({
        content: JSON.stringify({ ok: true, data: { matches: [{ path: 'studio/SKILL.md' }] } }),
        tool_call_id: 'search-call-1',
      })],
    },
  }), 'search-run-1');
  await collector.callback.handleLLMEnd?.({
    generations: [[{
      text: '',
      message: new AIMessage({
        content: '',
        tool_calls: [{
          id: 'search-call-1',
          name: 'capability_details',
          args: { names: ['kanban', 'task registration'] },
        }],
      }),
    }]],
  } as never, 'llm-run-1');

  assert.deepEqual(collector.read(), {
    detailCalls: 1,
    detailRounds: 1,
    detailRequests: [['kanban', 'task registration']],
    detailResults: [{
      ok: true,
      data: { matches: [{ path: 'studio/SKILL.md' }] },
    }],
  });
});

test('capability search diagnostics recognize real tool callback events', async () => {
  const collector = createCapabilityDetailsDiagnosticsCollector();
  const search = tool(async ({ names: terms }) => JSON.stringify({ ok: true, names: terms }), {
    name: 'capability_details',
    description: 'Search test capabilities.',
    schema: z.object({ names: z.array(z.string()) }),
  });

  await search.invoke(
    { names: ['kanban'] },
    { callbacks: [collector.callback] },
  );

  assert.deepEqual(collector.read(), {
    detailCalls: 1,
    detailRounds: 0,
    detailRequests: [['kanban']],
    detailResults: [{ ok: true, names: ['kanban'] }],
  });
});
