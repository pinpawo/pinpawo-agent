import type { RunnableConfig } from '@langchain/core/runnables';

export const SUBAGENT_EXECUTION_SCOPE_CONFIG_KEY = 'subagent_execution_scope';

/**
 * Stable across an interrupted delegation and its explicit continuation.
 * Host tools can use this identity to keep durable resources from leaking
 * into an unrelated fresh delegation.
 */
export type SubagentExecutionScope = {
  threadId: string | null;
  runId: string;
  delegationId: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readSubagentExecutionScope(
  runnableConfig?: RunnableConfig,
): SubagentExecutionScope | null {
  const value = runnableConfig?.configurable?.[SUBAGENT_EXECUTION_SCOPE_CONFIG_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const scope = value as Record<string, unknown>;
  if (
    !(scope.threadId === null || isNonEmptyString(scope.threadId))
    || !isNonEmptyString(scope.runId)
    || !isNonEmptyString(scope.delegationId)
  ) {
    return null;
  }
  return {
    threadId: scope.threadId,
    runId: scope.runId,
    delegationId: scope.delegationId,
  };
}

export function withSubagentExecutionScope(
  runnableConfig: RunnableConfig | undefined,
  scope: SubagentExecutionScope,
): RunnableConfig {
  return {
    ...runnableConfig,
    configurable: {
      ...runnableConfig?.configurable,
      [SUBAGENT_EXECUTION_SCOPE_CONFIG_KEY]: scope,
    },
  };
}
