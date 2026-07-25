import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  NamedStructuredTool,
  ToolDefinition,
  ToolReviewPolicy,
} from './toolkit';
import { defineToolkit } from './toolkit';

const alphaTool = { name: 'alpha_tool' } as NamedStructuredTool<'alpha_tool'>;
const betaTool = { name: 'beta_tool' } as NamedStructuredTool<'beta_tool'>;

const reviewPolicy = {
  request: () => null,
} satisfies ToolReviewPolicy;

test('defineToolkit preserves typed ToolDefinition entries', () => {
  const definitions = [
    {
      tool: alphaTool,
      operation: { title: 'Alpha' },
    },
    {
      tool: betaTool,
      review: reviewPolicy,
    },
  ] as const satisfies readonly ToolDefinition[];

  const toolkit = defineToolkit({
    name: 'typed_toolkit',
    description: 'Type-level toolkit contract coverage.',
    tools: definitions,
  });

  assert.equal(toolkit.tools[0].tool.name, 'alpha_tool');
  assert.equal(toolkit.tools[0].operation?.title, 'Alpha');
  assert.equal(toolkit.tools[1].review, reviewPolicy);
});

test('ToolDefinition requires an executable tool', () => {
  // @ts-expect-error ToolDefinition cannot contain metadata without a tool
  const invalidDefinition: ToolDefinition = {
    operation: { title: 'Missing implementation' },
  };

  assert.equal(invalidDefinition.operation?.title, 'Missing implementation');
});
