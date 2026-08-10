import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import type { NamedStructuredTool, ToolReviewPolicy } from './toolkit';
import {
  defineToolkit,
  evaluateToolkitAvailability,
  filterAvailableToolkits,
  TOOLKIT_REVIEW_GUIDANCE_FIELD_MAX_CHARS,
  validateToolkitDefinition,
} from './toolkit';

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

test('defineToolkit rejects duplicate tool names at runtime', () => {
  assert.throws(
    () => defineToolkit({
      name: 'duplicate_tools',
      description: 'Duplicate tool names should fail fast.',
      tools: [{ tool: alphaTool }, { tool: alphaTool }] as const,
    }),
    /duplicate tool "alpha_tool"/,
  );
});

test('defineToolkit requires a non-empty ToolDefinition list', () => {
  assert.throws(
    () => defineToolkit({
      name: 'empty_tools',
      description: 'Toolkits must own at least one tool.',
      tools: [],
    }),
    /must define at least one tool/,
  );
});

test('toolkit registration rejects oversized review guidance', () => {
  const oversized = 'x'.repeat(TOOLKIT_REVIEW_GUIDANCE_FIELD_MAX_CHARS + 1);

  assert.throws(
    () => defineToolkit({
      name: 'oversized_review_guidance',
      description: 'Invalid review guidance.',
      tools: [{ tool: alphaTool }],
      reviewGuidance: {
        allow: oversized,
        ask: 'Ask for risky operations.',
      },
    }),
    /review guidance allow exceeds 2000 characters/,
  );

  assert.throws(
    () => validateToolkitDefinition({
      name: 'runtime_registered_toolkit',
      description: 'Plugin-style toolkit definition.',
      tools: [{ tool: alphaTool }],
      reviewGuidance: {
        allow: 'Allow routine operations.',
        ask: oversized,
      },
    }),
    /review guidance ask exceeds 2000 characters/,
  );
});

test('toolkit registration rejects malformed static contract fields', () => {
  assert.throws(
    () => validateToolkitDefinition({
      name: 'dynamic_instructions',
      description: 'Toolkit instructions must already be resolved.',
      tools: [{ tool: alphaTool }],
      instructions: ['not', 'a', 'document'],
    } as never),
    /instructions must be a string/,
  );

  assert.throws(
    () => validateToolkitDefinition({
      name: 'invalid_review',
      description: 'Review policies must be bound to one ToolDefinition.',
      tools: [{ tool: alphaTool, review: {} }],
    } as never),
    /review must define request\(\)/,
  );

  assert.throws(
    () => validateToolkitDefinition({
      name: 'non_executable_tool',
      description: 'A name alone is not a StructuredTool.',
      tools: [{ tool: { name: 'noop' } }],
    } as never),
    /must be an executable StructuredTool/,
  );

  assert.throws(
    () => validateToolkitDefinition({
      name: 'invalid_operation_callback',
      description: 'Operation callbacks must be callable.',
      tools: [{
        tool: alphaTool,
        operation: { summarizeInput: 1 },
      }],
    } as never),
    /operation\.summarizeInput must be a function/,
  );

  assert.throws(
    () => validateToolkitDefinition({
      name: 'invalid_review_callback',
      description: 'Optional review callbacks must be callable.',
      tools: [{
        tool: alphaTool,
        review: {
          request: () => null,
          authorization: {
            buildMatcher: 1,
          },
        },
      }],
    } as never),
    /review\.authorization\.buildMatcher must be a function/,
  );
});

test('defineToolkit keeps implementation, operation, and review in one ToolDefinition', () => {
  const toolkit = defineToolkit({
    name: 'valid_toolkit',
    description: 'Valid toolkit contract.',
    tools: [
      {
        tool: alphaTool,
        operation: { title: 'Alpha' },
      },
      {
        tool: betaTool,
        review: reviewPolicy,
      },
    ] as const,
    reviewGuidance: {
      allow: 'Allow alpha operations when explicitly requested.',
      ask: 'Ask before beta operations that delete data.',
    },
  });

  assert.deepEqual(
    toolkit.tools.map((definition) => definition.tool.name),
    ['alpha_tool', 'beta_tool'],
  );
  assert.equal(toolkit.tools[0].operation?.title, 'Alpha');
  assert.equal(toolkit.tools[1].review, reviewPolicy);
  assert.deepEqual(toolkit.reviewGuidance, {
    allow: 'Allow alpha operations when explicitly requested.',
    ask: 'Ask before beta operations that delete data.',
  });
});

test('filterAvailableToolkits excludes unavailable and failed checks for one generation', async () => {
  const available = defineToolkit({
    name: 'available',
    description: 'Available Toolkit.',
    tools: [{ tool: alphaTool }],
    availability: async () => ({ available: true }),
  });
  const unavailable = defineToolkit({
    name: 'unavailable',
    description: 'Unavailable Toolkit.',
    tools: [{ tool: betaTool }],
    availability: () => ({ available: false, reason: 'offline' }),
  });
  const failed = defineToolkit({
    name: 'failed',
    description: 'Failed availability check.',
    tools: [{ tool: betaTool }],
    availability: () => {
      throw new Error('check failed');
    },
  });

  assert.deepEqual(
    (await filterAvailableToolkits([available, unavailable, failed]))
      .map(({ name }) => name),
    ['available'],
  );
  assert.deepEqual(await evaluateToolkitAvailability(failed), {
    available: false,
    reason: 'check failed',
  });
});
