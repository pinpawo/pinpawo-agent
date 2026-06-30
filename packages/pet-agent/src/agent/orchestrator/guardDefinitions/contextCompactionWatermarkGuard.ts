import {
  defineGuard,
  guardBlock,
  guardPass,
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
  type OrchestratorGuard,
  type OrchestratorGuardConfig,
  type OrchestratorGuardPosition,
  type OrchestratorGuardUpdate,
} from './types';

const DEFAULT_KEEP_MESSAGES = 10;

export function createContextCompactionWatermarkGuard(): OrchestratorGuard {
  return defineGuard<
    OrchestratorStateType,
    OrchestratorGuardConfig,
    OrchestratorGuardPosition,
    OrchestratorGuardUpdate
  >({
    name: ORCHESTRATOR_GUARD_NAME.CONTEXT_COMPACTION_WATERMARK,
    positions: [ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION],
    rule: {
      check: ({ config, state }) => {
        const keepMessages = config.contextCompaction?.keepMessages ?? DEFAULT_KEEP_MESSAGES;
        const triggerMessages = mainConversationMessages(state.messages);
        if (triggerMessages.length <= keepMessages) {
          return guardPass();
        }

        const watermark = checkProviderInputWatermark(
          readLatestProviderInputTokens(triggerMessages),
          config.contextWindowTokens,
        );
        if (!watermark) {
          return guardPass();
        }

        return guardBlock('context_compaction_required', {
          mainMessageCount: triggerMessages.length,
          keepMessages,
          ...watermark,
        });
      },
    },
    handler: {
      handle: () => null,
    },
  });
}
