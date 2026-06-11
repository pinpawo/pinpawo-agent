import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NamedStructuredTool, ToolkitToolReviewPolicy } from './toolkit';
import { defineToolkit, defineToolset } from './toolkit';

const alphaTool = { name: 'alpha_tool' } as NamedStructuredTool<'alpha_tool'>;
const betaTool = { name: 'beta_tool' } as NamedStructuredTool<'beta_tool'>;

const reviewPolicy = {
  request: () => null,
} satisfies ToolkitToolReviewPolicy;

test('defineToolkit accepts operation metadata and review policies keyed by declared tools', () => {
  const toolkit = defineToolkit({
    name: 'typed_toolkit',
    description: 'Type-level toolkit contract coverage.',
    tools: [alphaTool, betaTool] as const,
    operations: {
      alpha_tool: { title: 'Alpha' },
    },
    policy: {
      toolReview: {
        beta_tool: reviewPolicy,
      },
    },
  });

  assert.equal(toolkit.operations?.alpha_tool?.title, 'Alpha');
});

test('defineToolkit rejects operation metadata keys outside declared tools', () => {
  assert.throws(
    () => defineToolkit({
      name: 'invalid_operation_key',
      description: 'Operation metadata keys must match toolkit tools.',
      tools: [alphaTool] as const,
      operations: {
        alpha_tool: {},
        // @ts-expect-error operation metadata keys must come from toolkit tools
        beta_tool: {},
      },
    }),
    /operation metadata references unknown tool "beta_tool"/,
  );
});

test('defineToolkit rejects review policy keys outside declared tools', () => {
  assert.throws(
    () => defineToolkit({
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
    }),
    /review policy references unknown tool "beta_tool"/,
  );
});

test('defineToolset rejects operation metadata and review keys outside declared tools', () => {
  assert.throws(
    () => defineToolset({
      name: 'typed_toolset',
      description: 'Type-level toolset contract coverage.',
      tools: [alphaTool] as const,
      operations: {
        alpha_tool: {},
        // @ts-expect-error toolset operation metadata keys must come from toolset tools
        beta_tool: {},
      },
      policy: {
        toolReview: {
          alpha_tool: reviewPolicy,
          // @ts-expect-error toolset review policy keys must come from toolset tools
          beta_tool: reviewPolicy,
        },
      },
    }),
    /operation metadata references unknown tool "beta_tool"/,
  );
});

test('defineToolset rejects review policy keys outside declared tools', () => {
  assert.throws(
    () => defineToolset({
      name: 'typed_toolset_invalid_review',
      description: 'Type-level toolset review contract coverage.',
      tools: [alphaTool] as const,
      policy: {
        toolReview: {
          alpha_tool: reviewPolicy,
          // @ts-expect-error toolset review policy keys must come from toolset tools
          beta_tool: reviewPolicy,
        },
      },
    }),
    /review policy references unknown tool "beta_tool"/,
  );
});

test('defineToolset accepts operation metadata and review policies keyed by declared tools', () => {
  const toolset = defineToolset({
    name: 'valid_typed_toolset',
    description: 'Valid type-level toolset contract coverage.',
    tools: [alphaTool] as const,
    operations: {
      alpha_tool: { title: 'Alpha' },
    },
    policy: {
      toolReview: {
        alpha_tool: reviewPolicy,
      },
    },
  });

  assert.equal(toolset.operations?.alpha_tool?.title, 'Alpha');
});
