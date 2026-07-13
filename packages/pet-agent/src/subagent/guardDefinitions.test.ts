import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { evaluateGuard } from '../guards';
import {
  CONTEXT_MAINTENANCE_REQUIRED,
  contextMaintenanceGuard,
  SUBAGENT_GUARD_POSITION,
  SUBAGENT_ITERATION_LIMIT_REACHED,
  subagentIterationLimitGuard,
} from './guardDefinitions';
import {
  buildSubagentIterationLimitStopNotice,
  readSubagentGuardStopReason,
} from './guardStop';

function usageMessage(content: string, inputTokens: number) {
  return new AIMessage({
    content,
    usage_metadata: {
      input_tokens: inputTokens,
      output_tokens: 10,
      total_tokens: inputTokens + 10,
    },
  });
}

test('context maintenance guard maintains at the provider input watermark', () => {
  const messages = [
    new HumanMessage('do the task'),
    usageMessage('previous provider usage', 900),
  ];

  const outcome = evaluateGuard(contextMaintenanceGuard, {
    state: {
      messages,
      contextManagement: { rewrite: (input) => input },
    },
    config: { contextWindowTokens: 1000 },
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_MANAGEMENT,
  });

  assert.equal(outcome.kind, 'maintain');
  assert.equal(outcome.kind === 'maintain' && outcome.reason, CONTEXT_MAINTENANCE_REQUIRED);
  assert.deepEqual(outcome.kind === 'maintain' && outcome.details, {
    trigger: 'provider_input_watermark',
    latestInputTokens: 900,
    watermarkTokens: 750,
  });
});

test('context maintenance guard leaves single-result sizing to the toolkit below the watermark', () => {
  const outcome = evaluateGuard(contextMaintenanceGuard, {
    state: {
      messages: [
        new HumanMessage('inspect'),
        usageMessage('previous provider usage', 400),
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'call-large', name: 'read_file', args: { path: 'large.log' } }],
        }),
        new ToolMessage({
          tool_call_id: 'call-large',
          content: 'x'.repeat(20_001),
        }),
      ],
      contextManagement: {
        evictToolResults: {
          keepRecent: 5,
        },
      },
    },
    config: { contextWindowTokens: 1000 },
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_MANAGEMENT,
  });

  assert.equal(outcome.kind, 'proceed');
});

test('context maintenance guard proceeds when disabled or below the watermark', () => {
  const messages = [usageMessage('usage', 900)];

  const disabled = evaluateGuard(contextMaintenanceGuard, {
    state: { messages },
    config: { contextWindowTokens: 1000 },
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_MANAGEMENT,
  });
  assert.equal(disabled.kind, 'proceed');

  const belowWatermark = evaluateGuard(contextMaintenanceGuard, {
    state: {
      messages: [usageMessage('usage', 400)],
      contextManagement: { rewrite: (input) => input },
    },
    config: { contextWindowTokens: 1000 },
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_MANAGEMENT,
  });
  assert.equal(belowWatermark.kind, 'proceed');
});

test('subagent iteration limit guard stops past the budget with the count evidence', () => {
  const stop = evaluateGuard(subagentIterationLimitGuard, {
    state: { iterationCount: 5, maxIterations: 4 },
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });
  assert.equal(stop.kind, 'stop');
  assert.equal(stop.kind === 'stop' && stop.reason, SUBAGENT_ITERATION_LIMIT_REACHED);
  assert.deepEqual(stop.kind === 'stop' && stop.details, {
    iterationCount: 5,
    maxIterations: 4,
  });

  const proceed = evaluateGuard(subagentIterationLimitGuard, {
    state: { iterationCount: 4, maxIterations: 4 },
    config: {},
    position: SUBAGENT_GUARD_POSITION.BEFORE_MODEL_ITERATION,
  });
  assert.equal(proceed.kind, 'proceed');
});

test('iteration limit stop notice carries the closed guard stop marker', () => {
  const notice = buildSubagentIterationLimitStopNotice(5, 4);

  assert.match(String(notice.content), /attempted 5, limit 4/);
  assert.equal(readSubagentGuardStopReason(notice), 'subagent_iteration_limit_reached');
});
