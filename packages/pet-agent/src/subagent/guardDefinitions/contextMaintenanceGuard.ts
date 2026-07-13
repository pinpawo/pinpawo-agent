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
  type ContextMaintenanceGuardConfig,
  type ContextMaintenanceGuardState,
  type SubagentGuardPosition,
} from './types';

export const CONTEXT_MAINTENANCE_REQUIRED = 'context_maintenance_required';

export const contextMaintenanceGuard = defineGuard<
  ContextMaintenanceGuardState,
  ContextMaintenanceGuardConfig,
  SubagentGuardPosition
>({
  name: SUBAGENT_GUARD_NAME.CONTEXT_MAINTENANCE,
  positions: [SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_MANAGEMENT],
  check: ({ config, state }) => {
    const management = state.contextManagement;
    if (!management?.rewrite && !management?.rewriteAsync && !management?.evictToolResults) {
      return guardProceed();
    }
    const watermark = checkProviderInputWatermark(
      readLatestProviderInputTokens(state.messages),
      config.contextWindowTokens,
    );
    if (!watermark) {
      return guardProceed();
    }
    return guardMaintain(CONTEXT_MAINTENANCE_REQUIRED, {
      trigger: 'provider_input_watermark',
      ...watermark,
    });
  },
});
