import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { NamedStructuredTool, ToolkitToolReviewPolicy } from './toolkit';
import {
  defineToolkit,
  defineToolset,
  hasToolOperationMetadata,
  TOOLKIT_AUTO_REVIEW_FIELD_MAX_CHARS,
  validateToolkitDefinition,
} from './toolkit';

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
        alpha_tool: {},
        beta_tool: {},
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

test('toolkit registration rejects oversized auto-review fields', () => {
  const oversized = 'x'.repeat(TOOLKIT_AUTO_REVIEW_FIELD_MAX_CHARS + 1);

  assert.throws(
    () => defineToolkit({
      name: 'oversized_auto_review',
      description: 'Invalid auto-review policy.',
      tools: [alphaTool] as const,
      policy: {
        autoReview: {
          allow: oversized,
          ask: 'Ask for risky operations.',
        },
      },
    }),
    /auto-review allow exceeds 2000 characters/,
  );

  assert.throws(
    () => validateToolkitDefinition({
      name: 'runtime_registered_toolkit',
      description: 'Plugin-style toolkit definition.',
      policy: {
        autoReview: {
          allow: 'Allow routine operations.',
          ask: oversized,
        },
      },
    }),
    /auto-review ask exceeds 2000 characters/,
  );
});

test('defineToolkit preserves valid tool metadata and review policy', () => {
  const toolkit = defineToolkit({
    name: 'valid_toolkit',
    description: 'Valid toolkit contract.',
    tools: [alphaTool, betaTool] as const,
    operations: {
      alpha_tool: { title: 'Alpha' },
    },
    policy: {
      autoReview: {
        allow: 'Allow alpha operations when explicitly requested.',
        ask: 'Ask before beta operations that delete data.',
      },
      toolReview: {
        beta_tool: reviewPolicy,
      },
    },
  });

  assert.ok(Array.isArray(toolkit.tools));
  assert.deepEqual(toolkit.tools.map((tool) => tool.name), ['alpha_tool', 'beta_tool']);
  assert.equal(toolkit.operations?.alpha_tool?.title, 'Alpha');
  assert.equal(toolkit.policy?.toolReview?.beta_tool, reviewPolicy);
  assert.deepEqual(toolkit.policy?.autoReview, {
    allow: 'Allow alpha operations when explicitly requested.',
    ask: 'Ask before beta operations that delete data.',
  });
});

test('hasToolOperationMetadata treats empty operation maps as absent', () => {
  assert.equal(hasToolOperationMetadata(undefined), false);
  assert.equal(hasToolOperationMetadata({}), false);
  assert.equal(hasToolOperationMetadata({ alpha_tool: {} }), true);
});
