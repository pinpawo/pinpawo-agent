import {
  defineGuard,
  type GuardBlock,
  type GuardBlockHandler,
  type GuardOptions,
  guardBlock,
  guardPass,
} from '../../guards';
import { readLatestProviderInputTokens } from '../../agent/tokenUsage';
import { buildContextPolicyTriggerTokens } from '../contextPolicy';
import {
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuard,
  type SubagentGuardConfig,
  type SubagentState,
  type SubagentGuardUpdate,
} from './types';

export type ContextRewriteWatermarkGuardBlockInput = {
  state: SubagentState;
  config: SubagentGuardConfig;
  result: GuardBlock;
};

export type ContextRewriteWatermarkGuardBlockHandler = GuardBlockHandler<
  ContextRewriteWatermarkGuardBlockInput,
  SubagentGuardUpdate
>;

export type ContextRewriteWatermarkGuardOptions = GuardOptions<
  ContextRewriteWatermarkGuardBlockInput,
  SubagentGuardUpdate
>;

export function createContextRewriteWatermarkGuard(
  options: ContextRewriteWatermarkGuardOptions,
): SubagentGuard {
  return defineGuard({
    name: SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK,
    positions: [SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY],
    rule: {
      check: ({ config, state }) => {
        const evictPolicy = config.contextPolicy?.evictToolResults;
        if (!evictPolicy) {
          return guardPass();
        }
        const latestInputTokens = readLatestProviderInputTokens(state.messages);
        const triggerTokens = buildContextPolicyTriggerTokens(
          evictPolicy,
          {
            iterationCount: config.iterationCount,
            operations: config.operations ?? {},
            ...(config.contextWindowTokens ? { contextWindowTokens: config.contextWindowTokens } : {}),
            ...(latestInputTokens !== null ? { latestProviderInputTokens: latestInputTokens } : {}),
          },
        );

        if (
          latestInputTokens === null
          || triggerTokens === null
          || latestInputTokens < triggerTokens
        ) {
          return guardPass();
        }

        return guardBlock('context_rewrite_required', {
          latestInputTokens,
          triggerTokens,
        });
      },
    },
    handler: {
      handle: ({ config, result, state }) => {
        if (result.status === 'pass') {
          return null;
        }
        return options.onBlock({ state, config, result });
      },
    },
  });
}
