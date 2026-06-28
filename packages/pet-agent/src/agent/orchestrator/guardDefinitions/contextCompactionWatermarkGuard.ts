import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../../guards';
import { readLatestProviderInputTokens } from '../../tokenUsage';
import {
  buildContextCompactionTriggerTokens,
} from '../contextCompaction';
import { mainConversationMessages } from '../messageLanes';
import {
  ORCHESTRATOR_GUARD_NAME,
  ORCHESTRATOR_GUARD_POSITION,
  requestContextCompaction,
  type OrchestratorGuard,
} from './types';

const DEFAULT_KEEP_MESSAGES = 10;

type ContextCompactionTriggerDetails = {
  mainMessageCount: number;
  keepMessages: number;
  latestInputTokens: number;
  triggerTokens: number;
};

function readTriggerDetails(details: unknown): ContextCompactionTriggerDetails | null {
  if (!details || typeof details !== 'object') return null;
  const record = details as Partial<ContextCompactionTriggerDetails>;
  if (
    typeof record.mainMessageCount !== 'number'
    || typeof record.keepMessages !== 'number'
    || typeof record.latestInputTokens !== 'number'
    || typeof record.triggerTokens !== 'number'
  ) {
    return null;
  }
  return {
    mainMessageCount: record.mainMessageCount,
    keepMessages: record.keepMessages,
    latestInputTokens: record.latestInputTokens,
    triggerTokens: record.triggerTokens,
  };
}

export function createContextCompactionWatermarkGuard(): OrchestratorGuard {
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
      handle: ({ result }) => {
        if (result.status === 'pass') {
          return null;
        }
        const details = readTriggerDetails(result.details);
        return details
          ? requestContextCompaction(details)
          : null;
      },
    },
  });
}
