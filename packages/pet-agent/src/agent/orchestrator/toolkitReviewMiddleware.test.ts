import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { createToolkitReviewMiddleware, type ToolkitReviewBinding, type ToolkitReviewRuntimeContext } from './toolkitReviewMiddleware';

test('ToolkitReviewMiddleware returns no update when no tool call needs review', async () => {
  const binding = {
    toolkit: { name: 'guarded-toolkit' },
    toolName: 'guarded_tool',
    reviewPolicy: {},
  } as unknown as ToolkitReviewBinding;
  const middleware = createToolkitReviewMiddleware([binding], {
    models: {},
    messages: [],
  } as unknown as ToolkitReviewRuntimeContext);
  const afterModel = middleware?.afterModel;
  assert.ok(afterModel && typeof afterModel === 'object');

  // LangChain writes back the whole state for any non-undefined result, so an
  // allowed batch must not return `{}`.
  const update = await afterModel.hook({
    messages: [
      new HumanMessage('list files'),
      new AIMessage({ content: '', tool_calls: [{ id: 'call-1', name: 'unreviewed_tool', args: {} }] }),
    ],
  } as never, {} as never);
  assert.equal(update, undefined);
});

test('ToolkitReviewMiddleware passes the runtime workdir to a tool review policy', async () => {
  let observedWorkdir: string | null | undefined;
  const binding = {
    toolkit: { name: 'local' },
    toolName: 'download_artifact',
    reviewPolicy: { request: (context) => { observedWorkdir = context.workdir; return null; } },
  } as ToolkitReviewBinding;
  const middleware = createToolkitReviewMiddleware([binding], {
    models: {}, messages: [], reviewContext: { workdir: '/runtime/workdir' },
  } as unknown as ToolkitReviewRuntimeContext);
  const hook = middleware?.afterModel;
  assert.ok(hook && typeof hook === 'object');
  const update = await hook.hook({ messages: [new AIMessage({ content: '',
    tool_calls: [{ id: 'download', name: 'download_artifact', args: { uri: 'artifact://one/report.txt' } }],
  })] } as never, {} as never);
  assert.equal(observedWorkdir, '/runtime/workdir');
  assert.equal(update, undefined);
});
