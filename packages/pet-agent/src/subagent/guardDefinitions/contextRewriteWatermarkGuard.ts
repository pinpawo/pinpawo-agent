import {
  defineGuard,
  guardBlock,
  guardPass,
} from '../../guards';
import { readLatestProviderInputTokens } from '../../agent/tokenUsage';
import { buildContextPolicyTriggerTokens } from '../contextPolicy';
import {
  requestContextRewrite,
  SUBAGENT_GUARD_NAME,
  SUBAGENT_GUARD_POSITION,
  type SubagentGuard,
} from './types';

type ContextRewriteTriggerDetails = {
  latestInputTokens: number;
  triggerTokens: number;
};

function readTriggerDetails(details: unknown): ContextRewriteTriggerDetails | null {
  if (!details || typeof details !== 'object') return null;
  const record = details as Partial<ContextRewriteTriggerDetails>;
  if (
    typeof record.latestInputTokens !== 'number'
    || typeof record.triggerTokens !== 'number'
  ) {
    return null;
  }
  return {
    latestInputTokens: record.latestInputTokens,
    triggerTokens: record.triggerTokens,
  };
}

export function createContextRewriteWatermarkGuard(): SubagentGuard {
  return defineGuard({
    name: SUBAGENT_GUARD_NAME.CONTEXT_REWRITE_WATERMARK,
    positions: [SUBAGENT_GUARD_POSITION.BEFORE_MODEL_CONTEXT_POLICY],
    rule: {
      check: ({ config, state }) => {
        const evictPolicy = config.contextPolicy?.evictToolResults;
        if (!evictPolicy) {
          return guardPass();
        }
        const latestInputTokens = readLatestProviderInputTokens(state.messages);
        const triggerTokens = buildContextPolicyTriggerTokens(evictPolicy, {
          iterationCount: config.iterationCount,
          operations: config.operations ?? {},
          ...(config.contextWindowTokens ? { contextWindowTokens: config.contextWindowTokens } : {}),
          ...(latestInputTokens !== null ? { latestProviderInputTokens: latestInputTokens } : {}),
        });

        if (
          latestInputTokens === null
          || triggerTokens === null
          || latestInputTokens < triggerTokens
        ) {
          return guardPass();
        }

        return guardBlock('context_rewrite_required', {
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
          ? requestContextRewrite(details)
          : null;
      },
    },
  });
}
