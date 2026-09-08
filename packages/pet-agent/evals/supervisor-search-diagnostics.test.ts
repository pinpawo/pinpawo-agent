import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage } from '@langchain/core/messages';
import { createSupervisorSearchDiagnostics } from './supervisor-search-diagnostics.ts';

test('search trace separates parallel tool calls from model rounds and preserves failures', async () => {
  let time = 0;
  const trace = createSupervisorSearchDiagnostics(() => time);
  const [search, timing] = trace.callbacks;
  await timing.handleChatModelStart?.({} as never, [], 'm1');
  time = 20;
  const output = { generations: [[{ text: '', message: new AIMessage({ content: '', tool_calls: [
    { name: 'capability_search', args: { terms: ['code'] }, id: 'a' },
    { name: 'capability_search', args: { terms: ['code'] }, id: 'b' },
  ] }) }]] };
  await search.handleLLMEnd?.(output, 'm1');
  await timing.handleLLMEnd?.(output, 'm1');
  for (const id of ['a', 'b']) {
    for (const callback of trace.callbacks) await callback.handleToolStart?.(
      { name: 'capability_search' } as never, '{"terms":["code"]}', id);
  }
  time = 25;
  await timing.handleToolEnd?.('{}', 'b');
  time = 30;
  await timing.handleToolError?.(new Error('failed'), 'a');
  await timing.handleChatModelStart?.({} as never, [], 'm2');
  const result = trace.read();
  assert.equal(result.searchCalls, 2);
  assert.equal(result.searchRounds, 1);
  assert.equal(result.repeatedQueries, 1);
  assert.equal(result.modelCalls, 2);
  assert.deepEqual(result.invocations.map(({ status }) => status), ['completed', 'error', 'completed', 'pending']);
  assert.equal(result.invocations[0].durationMs, 20);
  assert.equal(result.invocations[1].durationMs, 10);
  assert.equal(result.invocations[2].durationMs, 5);
});
