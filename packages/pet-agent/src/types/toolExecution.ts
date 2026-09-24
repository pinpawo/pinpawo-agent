import type { SubagentExecutionScope } from './subagent';

/**
 * The fixed context a Host supplies to one Tool call.
 *
 * `agentSessionId` is the Agent session (threadId) a Toolkit binds RS logical
 * sessions to; `workdir` is the call's execution condition for relative paths
 * and default cwd. Neither is part of any session relationship, and neither
 * enters review scope.
 */
export type ToolExecutionContext = Readonly<{
  agentSessionId: string | null;
  workdir: string | null;
}>;

function readTrimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Read the execution context from a Tool call's config (the `ToolRuntime`
 * passed to a LangChain tool function, or the config a StructuredTool's
 * `_call` receives). Missing fields read as null rather than throwing, so each
 * Toolkit decides how to report a call made outside an Agent session.
 */
export function readToolExecutionContext(config: unknown): ToolExecutionContext {
  const context = config && typeof config === 'object'
    ? Reflect.get(config, 'context')
    : undefined;
  const scope = context && typeof context === 'object'
    ? Reflect.get(context, 'executionScope') as Partial<SubagentExecutionScope> | undefined
    : undefined;
  return Object.freeze({
    agentSessionId: readTrimmed(scope?.threadId),
    workdir: readTrimmed(scope?.workdir),
  });
}
