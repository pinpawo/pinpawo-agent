import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../../guards';
import { readProviderInputWatermark } from '../../tokenUsage';
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
        const compactionConfig = config.contextCompaction;
        const keepMessages = compactionConfig?.keepMessages ?? DEFAULT_KEEP_MESSAGES;
        const triggerMessages = mainConversationMessages(state.messages);
        const mainMessageCount = triggerMessages.length;

        if (mainMessageCount <= keepMessages) {
          return guardPass();
        }

        const watermark = readProviderInputWatermark({
          messages: triggerMessages,
          contextWindowTokens: compactionConfig?.contextWindowTokens,
        });

        if (!watermark) {
          return guardPass();
        }

        return guardBlock('context_compaction_required', {
          mainMessageCount,
          keepMessages,
          latestInputTokens: watermark.latestInputTokens,
          watermarkTokens: watermark.watermarkTokens,
        });
      },
    },
    handler: {
      handle: () => null,
    },
  });
}
