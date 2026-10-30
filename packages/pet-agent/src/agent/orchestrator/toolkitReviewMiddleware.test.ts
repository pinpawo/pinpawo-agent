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

test('runtime evidence is refreshed for each review and reaches the resolver', async () => {
  const { ReviewPolicies, AuthorizationPolicies } = await import('../../autoReview/reviewPolicies');
  let source = 'echo local build';
  const observed: string[] = [];
  const grants: unknown[] = [];
  const binding: ToolkitReviewBinding = {
    toolkit: { name: 'shell' } as ToolkitReviewBinding['toolkit'],
    toolName: 'run_shell',
    reviewPolicy: {
      ...ReviewPolicies.required({ authorization: AuthorizationPolicies.exact({ reuseAutoReview: false }) }),
      collectEvidence: async ctx => {
        assert.equal(ctx.workdir, '/project');
        return source;
      },
    },
  };
  const { buildToolAuthorizationRecord } = await import('../../autoReview/reviewAuthorizations');
  const matcher = await binding.reviewPolicy.authorization!.buildMatcher({
    toolkitName: 'shell', toolName: 'run_shell', input: { command: 'npm run build' },
  });
  assert.ok(matcher);
  const context = {
    models: {}, messages: [], reviewContext: { workdir: '/project' },
    reviewCapabilities: { humanReview: false, sessionAuthorization: true },
    toolAuthorizations: [buildToolAuthorizationRecord({ toolName: 'run_shell', matcher, source: 'auto_review' })],
    recordToolAuthorizations: (records: unknown[]) => { grants.push(...records); },
    globalReviewPolicy: {
      mode: 'custom', reuseAutoAuthorizations: true,
      resolve: (ctx: { evidence?: string }) => {
        observed.push(ctx.evidence ?? '');
        return { type: 'authorize', reason: 'test approval' };
      },
    },
  } as unknown as ToolkitReviewRuntimeContext;
  for (const [index, nextSource] of ['echo local build', 'publish-package'].entries()) {
    source = nextSource;
    const middleware = createToolkitReviewMiddleware([binding], context);
    const afterModel = middleware?.afterModel;
    assert.ok(afterModel && typeof afterModel === 'object');
    await afterModel.hook({ messages: [new AIMessage({ content: '', tool_calls: [
      { id: `call-${index}`, name: 'run_shell', args: { command: 'npm run build' } },
    ] })] } as never, {} as never);
  }
  assert.deepEqual(observed, ['echo local build', 'publish-package']);
  assert.deepEqual(grants, []);
});
