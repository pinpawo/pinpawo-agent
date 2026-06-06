import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { NamedStructuredTool, ToolkitToolReviewPolicy } from '../types/toolkit';
import { defineToolkit, defineToolset, hasToolOperationMetadata } from '../types/toolkit';

const alphaTool = { name: 'alpha_tool' } as NamedStructuredTool<'alpha_tool'>;
const betaTool = { name: 'beta_tool' } as NamedStructuredTool<'beta_tool'>;

const reviewPolicy = {
  request: () => null,
} satisfies ToolkitToolReviewPolicy;

test('defineToolkit rejects duplicate tool names at runtime', () => {
  assert.throws(
    () => defineToolkit({
      name: 'duplicate_tools',
      description: 'Duplicate tool names should fail fast.',
      tools: [alphaTool, alphaTool] as const,
    }),
    /duplicate tool "alpha_tool"/,
  );
});

test('defineToolkit rejects operation metadata for unknown tools at runtime', () => {
  assert.throws(
    () => defineToolkit({
      name: 'unknown_operation',
      description: 'Operation metadata must be owned by a toolkit tool.',
      tools: [alphaTool] as const,
      operations: {
        alpha_tool: { kind: 'alpha.run' },
        beta_tool: { kind: 'beta.run' },
      } as never,
    }),
    /operation metadata references unknown tool "beta_tool"/,
  );
});

test('defineToolset rejects review policy for unknown tools at runtime', () => {
  assert.throws(
    () => defineToolset({
      name: 'unknown_review',
      description: 'Review policy must be owned by a toolset tool.',
      tools: [alphaTool] as const,
      policy: {
        toolReview: {
          beta_tool: reviewPolicy,
        },
      } as never,
    }),
    /review policy references unknown tool "beta_tool"/,
  );
});

test('defineToolkit preserves valid tool metadata and review policy', () => {
  const toolkit = defineToolkit({
    name: 'valid_toolkit',
    description: 'Valid toolkit contract.',
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

  assert.ok(Array.isArray(toolkit.tools));
  assert.deepEqual(toolkit.tools.map((tool) => tool.name), ['alpha_tool', 'beta_tool']);
  assert.equal(toolkit.operations?.alpha_tool?.kind, 'alpha.run');
  assert.equal(toolkit.policy?.toolReview?.beta_tool, reviewPolicy);
});

test('hasToolOperationMetadata treats empty operation maps as absent', () => {
  assert.equal(hasToolOperationMetadata(undefined), false);
  assert.equal(hasToolOperationMetadata({}), false);
  assert.equal(hasToolOperationMetadata({ alpha_tool: { kind: 'alpha.run' } }), true);
});
