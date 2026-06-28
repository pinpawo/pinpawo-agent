import {
  defineGuard,
  guardBlock,
  type GuardBlock,
  type GuardBlockHandler,
  type GuardOptions,
  guardPass,
} from '../../../guards';
import { readLatestProviderInputTokens } from '../../tokenUsage';
import {
  buildContextCompactionTriggerTokens,
} from '../contextCompaction';
import { mainConversationMessages } from '../messageLanes';
import type { OrchestratorStateType } from '../state';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  type OrchestratorGuard,
  type OrchestratorGuardConfig,
  type OrchestratorGuardUpdate,
} from './types';

const DEFAULT_KEEP_MESSAGES = 10;

export type ContextCompactionWatermarkGuardBlockInput = {
  state: OrchestratorStateType;
  config: OrchestratorGuardConfig;
  result: GuardBlock;
};

export type ContextCompactionWatermarkGuardBlockHandler = GuardBlockHandler<
  ContextCompactionWatermarkGuardBlockInput,
  OrchestratorGuardUpdate
>;

export type ContextCompactionWatermarkGuardOptions = GuardOptions<
  ContextCompactionWatermarkGuardBlockInput,
  OrchestratorGuardUpdate
>;

export function createContextCompactionWatermarkGuard(
  options: ContextCompactionWatermarkGuardOptions,
): OrchestratorGuard {
  return defineGuard({
    name: ORCHESTRATOR_GUARD_NAME.CONTEXT_COMPACTION_WATERMARK,
    positions: [ORCHESTRATOR_GUARD_POSITION.CONTEXT_COMPACTION],
    rule: {
      check: ({ config, state }) => {
        const compactionConfig = config.contextCompaction;
        const keepMessages = compactionConfig?.keepMessages ?? DEFAULT_KEEP_MESSAGES;
        const triggerMessages = mainConversationMessages(state.messages);
        const mainMessageCount = triggerMessages.length;
        const latestInputTokens = readLatestProviderInputTokens(triggerMessages);
        const triggerTokens = buildContextCompactionTriggerTokens({
          contextWindowTokens: compactionConfig?.contextWindowTokens,
          triggerRatio: compactionConfig?.triggerRatio,
          triggerTokens: compactionConfig?.triggerTokens,
        });

        if (
          mainMessageCount <= keepMessages
          || latestInputTokens === null
          || triggerTokens === null
          || latestInputTokens < triggerTokens
        ) {
          return guardPass();
        }

        return guardBlock('context_compaction_required', {
          mainMessageCount,
          keepMessages,
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
        return options.onBlock({
          state,
          config,
          result,
        });
      },
    },
  });
}
