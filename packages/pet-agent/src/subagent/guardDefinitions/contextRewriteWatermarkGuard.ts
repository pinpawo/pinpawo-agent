import {
  defineGuard,
  guardMaintain,
  guardProceed,
} from '../../guards';
import {
  checkProviderInputWatermark,
  readLatestProviderInputTokens,
} from '../../agent/tokenUsage';
import {
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type ContextRewriteWatermarkGuardConfig,
  type ContextRewriteWatermarkGuardState,
  type SubagentGuardPosition,
} from './types';

export const CONTEXT_REWRITE_REQUIRED = 'context_rewrite_required';

export const contextRewriteWatermarkGuard = defineGuard<
  ContextRewriteWatermarkGuardState,
  ContextRewriteWatermarkGuardConfig,
  SubagentGuardPosition
>({
  name: SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK,
  positions: [SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY],
  check: ({ config, state }) => {
    const policy = state.contextPolicy;
    if (!policy?.rewrite && !policy?.rewriteAsync && !policy?.evictToolResults) {
      return guardProceed();
    }
    const watermark = checkProviderInputWatermark(
      readLatestProviderInputTokens(state.messages),
      config.contextWindowTokens,
    );
    if (!watermark) {
      return guardProceed();
    }
    return guardMaintain(CONTEXT_REWRITE_REQUIRED, { ...watermark });
  },
});
