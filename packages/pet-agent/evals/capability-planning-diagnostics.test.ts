import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createCapabilitySearchDiagnosticsCollector } from './capability-planning-diagnostics.ts';

test('capability search diagnostics report traced calls, rounds, queries, and results', async () => {
  const collector = createCapabilitySearchDiagnosticsCollector();
  await collector.callback.handleToolStart?.(
    { name: 'capability_search' } as never,
    JSON.stringify({ terms: ['kanban', 'task registration'] }),
    'search-run-1',
    'planner-run',
    [],
    {},
    'capability_search',
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
          name: 'capability_search',
          args: { terms: ['kanban', 'task registration'] },
        }],
      }),
    }]],
  } as never, 'llm-run-1');

  assert.deepEqual(collector.read(), {
    searchCalls: 1,
    searchRounds: 1,
    searchQueries: [['kanban', 'task registration']],
    searchResults: [{
      ok: true,
      data: { matches: [{ path: 'studio/SKILL.md' }] },
    }],
  });
});

test('capability search diagnostics recognize real tool callback events', async () => {
  const collector = createCapabilitySearchDiagnosticsCollector();
  const search = tool(async ({ terms }) => JSON.stringify({ ok: true, terms }), {
    name: 'capability_search',
    description: 'Search test capabilities.',
    schema: z.object({ terms: z.array(z.string()) }),
  });

  await search.invoke(
    { terms: ['kanban'] },
    { callbacks: [collector.callback] },
  );

  assert.deepEqual(collector.read(), {
    searchCalls: 1,
    searchRounds: 0,
    searchQueries: [['kanban']],
    searchResults: [{ ok: true, terms: ['kanban'] }],
  });
});
