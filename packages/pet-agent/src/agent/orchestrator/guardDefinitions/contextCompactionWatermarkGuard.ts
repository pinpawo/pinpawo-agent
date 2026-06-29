import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../../guards';
import { readLatestProviderInputTokens } from '../../tokenUsage';
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
const CONTEXT_COMPACTION_WATERMARK_RATIO = 0.75;

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
        const latestInputTokens = readLatestProviderInputTokens(triggerMessages);
        const contextWindowTokens = compactionConfig?.contextWindowTokens;
        if (!contextWindowTokens || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
          return guardPass();
        }
        const watermarkTokens = Math.max(1, Math.floor(
          contextWindowTokens * CONTEXT_COMPACTION_WATERMARK_RATIO,
        ));

        if (
          mainMessageCount <= keepMessages
          || latestInputTokens === null
          || latestInputTokens < watermarkTokens
        ) {
          return guardPass();
        }

        return guardBlock('context_compaction_required', {
          mainMessageCount,
          keepMessages,
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
