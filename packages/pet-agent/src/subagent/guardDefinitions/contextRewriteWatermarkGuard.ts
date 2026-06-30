import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../guards';
import {
  checkProviderInputWatermark,
  readLatestProviderInputTokens,
} from '../../agent/tokenUsage';
import {
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuard,
  type SubagentGuardConfig,
  type SubagentGuardPosition,
  type SubagentState,
  type SubagentGuardUpdate,
} from './types';

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
      check: ({ config, state }) => {
        const policy = state.contextPolicy;
        if (!policy?.rewrite && !policy?.rewriteAsync && !policy?.evictToolResults) {
          return guardPass();
        }

        const watermark = checkProviderInputWatermark(
          readLatestProviderInputTokens(state.messages),
          config.contextWindowTokens,
        );
        if (!watermark) {
          return guardPass();
        }

        return guardBlock('context_rewrite_required', watermark);
      },
    },
    handler: {
      handle: () => null,
    },
  });
}
