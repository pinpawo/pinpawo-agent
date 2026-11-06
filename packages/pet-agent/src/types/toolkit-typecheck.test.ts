import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import type {
  AgentToolkit,
  NamedStructuredTool,
  ToolDefinition,
  ToolReviewPolicy,
} from './toolkit';
import type { ToolkitResult } from '../index';
import { defineToolkit } from './toolkit';

function mockTool<const TName extends string>(name: TName): NamedStructuredTool<TName> {
  return tool(async () => 'ok', {
    name,
    description: `${name} test tool`,
    schema: z.object({}),
  }) as NamedStructuredTool<TName>;
}

const alphaTool = mockTool('alpha_tool');
const betaTool = mockTool('beta_tool');

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

test('Toolkit getters expose synchronous public ToolkitResult values', () => {
  const result: ToolkitResult = { deliverables: [{ uri: 'artifact://report' }] };
  const getResult: NonNullable<AgentToolkit['getResult']> = () => result;
  // @ts-expect-error Toolkit result projection does not accept async functions
  const asynchronous: NonNullable<AgentToolkit['getResult']> = async () => result;
  assert.strictEqual(getResult({}), result);
  assert.equal(typeof asynchronous, 'function');
});
