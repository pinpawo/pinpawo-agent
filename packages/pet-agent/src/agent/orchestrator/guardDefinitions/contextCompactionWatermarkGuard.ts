import {
  defineGuard,
  guardMaintain,
  guardProceed,
} from '../../../guards';
import {
  checkProviderInputWatermark,
  readLatestProviderInputTokens,
} from '../../tokenUsage';
import { mainConversationMessages } from '../messageLanes';
import type { OrchestratorStateType } from '../state';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type ContextCompactionWatermarkGuardConfig,
  type OrchestratorGuardPosition,
} from './types';

export const CONTEXT_COMPACTION_REQUIRED = 'context_compaction_required';

const DEFAULT_KEEP_MESSAGES = 10;

export type ContextCompactionWatermarkGuardState = Pick<OrchestratorStateType, 'messages'>;

export const contextCompactionWatermarkGuard = defineGuard<
  ContextCompactionWatermarkGuardState,
  ContextCompactionWatermarkGuardConfig,
  OrchestratorGuardPosition
>({
  name: ORCHESTRATOR_GUARD_NAME.CONTEXT_COMPACTION_WATERMARK,
  positions: [ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION],
  check: ({ config, state }) => {
    const keepMessages = config.keepMessages ?? DEFAULT_KEEP_MESSAGES;
    const triggerMessages = mainConversationMessages(state.messages);
    if (triggerMessages.length <= keepMessages) {
      return guardProceed();
    }
    const watermark = checkProviderInputWatermark(
      readLatestProviderInputTokens(triggerMessages),
      config.contextWindowTokens,
    );
    if (!watermark) {
      return guardProceed();
    }
    return guardMaintain(CONTEXT_COMPACTION_REQUIRED, {
      mainMessageCount: triggerMessages.length,
      keepMessages,
      ...watermark,
    });
  },
});
