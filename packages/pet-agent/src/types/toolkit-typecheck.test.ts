import type { NamedStructuredTool, ToolkitToolReviewPolicy } from './toolkit';
import { defineToolkit, defineToolset } from './toolkit';

const alphaTool = { name: 'alpha_tool' } as NamedStructuredTool<'alpha_tool'>;
const betaTool = { name: 'beta_tool' } as NamedStructuredTool<'beta_tool'>;

const reviewPolicy = {
  request: () => null,
} satisfies ToolkitToolReviewPolicy;

defineToolkit({
  name: 'typed_toolkit',
  description: 'Type-level toolkit contract coverage.',
  tools: [alphaTool, betaTool] as const,
  operations: {
    alpha_tool: { kind: 'alpha.run' },
  },
  policy: {
    toolReview: {
      beta_tool: reviewPolicy,
    },
  },
});

defineToolkit({
  name: 'invalid_operation_key',
  description: 'Operation metadata keys must match toolkit tools.',
  tools: [alphaTool] as const,
  operations: {
    alpha_tool: { kind: 'alpha.run' },
    // @ts-expect-error operation metadata keys must come from toolkit tools
    beta_tool: { kind: 'beta.run' },
  },
});

defineToolkit({
  name: 'invalid_review_key',
  description: 'Review policy keys must match toolkit tools.',
  tools: [alphaTool] as const,
  policy: {
    toolReview: {
      alpha_tool: reviewPolicy,
      // @ts-expect-error review policy keys must come from toolkit tools
      beta_tool: reviewPolicy,
    },
  },
});

defineToolset({
  name: 'typed_toolset',
  description: 'Type-level toolset contract coverage.',
  tools: [alphaTool] as const,
  operations: {
    alpha_tool: { kind: 'alpha.run' },
    // @ts-expect-error toolset operation metadata keys must come from toolset tools
    beta_tool: { kind: 'beta.run' },
  },
  policy: {
    toolReview: {
      alpha_tool: reviewPolicy,
      // @ts-expect-error toolset review policy keys must come from toolset tools
      beta_tool: reviewPolicy,
    },
  },
});
