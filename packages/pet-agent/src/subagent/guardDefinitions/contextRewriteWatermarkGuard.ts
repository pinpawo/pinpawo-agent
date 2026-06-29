import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../guards';
import { readLatestProviderInputTokens } from '../../agent/tokenUsage';
import {
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuard,
  type SubagentGuardConfig,
  type SubagentGuardPosition,
  type SubagentState,
  type SubagentGuardUpdate,
} from './types';

const CONTEXT_REWRITE_WATERMARK_RATIO = 0.75;

export function createContextRewriteWatermarkGuard(): SubagentGuard {
  return defineGuard<
    SubagentState,
    SubagentGuardConfig,
    SubagentGuardPosition,
    SubagentGuardUpdate
  >({
    name: SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK,
    positions: [SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY],
    rule: {
      check: ({ state }) => {
        const policy = state.contextPolicy;
        if (!policy?.rewrite && !policy?.rewriteAsync && !policy?.evictToolResults) {
          return guardPass();
        }
        if (!state.contextWindowTokens || !Number.isFinite(state.contextWindowTokens) || state.contextWindowTokens <= 0) {
          return guardPass();
        }
        const latestInputTokens = readLatestProviderInputTokens(state.messages);
        const watermarkTokens = Math.max(1, Math.floor(
          state.contextWindowTokens * CONTEXT_REWRITE_WATERMARK_RATIO,
        ));

        if (
          latestInputTokens === null
          || latestInputTokens < watermarkTokens
        ) {
          return guardPass();
        }

        return guardBlock('context_rewrite_required', {
          latestInputTokens,
          watermarkTokens,
        });
      },
    },
    handler: {
      handle: () => null,
    },
  });
}
