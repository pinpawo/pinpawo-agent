import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { getAgentMessageMetadata, getAgentMessageRunId } from '../messages';
import { DELEGATE_CAPABILITY_TOOL_NAME, readCapabilityExecutionRecord } from './executionMessages';
import { PLAN_REQUEST_TOOL_NAME } from './runtime/nodes/entryAnswer';
import { currentSupervisorTask, type RunSupervisorState } from './runSupervisor/state';

/** Entry Answer's routing decisions: control flow, not work the conversation shows. */
const ENTRY_ROUTING_TOOL_NAMES = new Set([PLAN_REQUEST_TOOL_NAME, 'continue']);

export type MainToolCallStatus = 'running' | 'returned' | 'missing' | 'declined' | 'failed';

export type MainToolCall = {
  id: string;
  name: string;
  /** One display line: a delegation's plan item, otherwise the tool name. */
  title: string;
  /** Display detail: a delegation's briefing, otherwise the arguments. */
  input?: string;
  status: MainToolCallStatus;
};

/** A main-conversation turn in which Root itself called tools. */
export type MainToolCallMessage = {
  messageId: string;
  runId: string | null;
  /** Whatever the model said alongside its calls; often empty. */
  text: string;
  toolCalls: MainToolCall[];
};

/**
 * Project the tool calls Root made in the main conversation, with their
 * outcomes, from canonical messages alone. Private lanes, synthetic messages
 * and Entry routing are not conversation work and are left out.
 *
 * `state` is the Root state the messages were committed with. It only names a
 * delegation still running in that state's run, whose plan item is not on any
 * result yet; everything else is read from the messages.
 */
export function readMainToolCallMessages(
  messages: readonly BaseMessage[],
  state?: { runSupervisorState?: RunSupervisorState | null },
): MainToolCallMessage[] {
  const results = new Map<string, ToolMessage>();
  for (const message of messages) {
    if (ToolMessage.isInstance(message) && !getAgentMessageMetadata(message).lane) results.set(message.tool_call_id, message);
  }
  const projected = messages.flatMap((message): MainToolCallMessage[] => {
    if (!AIMessage.isInstance(message) || !message.id || !message.tool_calls?.length) return [];
    const metadata = getAgentMessageMetadata(message);
    if (metadata.lane || metadata.synthetic) return [];
    const calls = message.tool_calls.filter(call => call.id && !ENTRY_ROUTING_TOOL_NAMES.has(call.name));
    if (!calls.length) return [];
    return [{
      messageId: message.id,
      runId: getAgentMessageRunId(message),
      text: message.text,
      toolCalls: calls.map(call => projectCall(call.name, call.id!, call.args, results.get(call.id!))),
    }];
  });
  // A delegation without a result is the one the state's run is executing only
  // if it is that run's newest one; its plan item is the state's current task.
  const plan = state?.runSupervisorState;
  const task = plan ? currentSupervisorTask(plan) : null;
  const running = projected.filter(message => message.runId && message.runId === plan?.runId).at(-1)
    ?.toolCalls.find(call => call.name === DELEGATE_CAPABILITY_TOOL_NAME && call.status === 'running');
  if (running && task) running.title = task.objective;
  return projected;
}

function projectCall(name: string, id: string, args: Record<string, unknown> | undefined, result: ToolMessage | undefined): MainToolCall {
  if (name === DELEGATE_CAPABILITY_TOOL_NAME) {
    const briefing = typeof args?.briefing === 'string' ? args.briefing : '';
    const record = result ? readCapabilityExecutionRecord(result) : null;
    const base = { id, name, title: firstLine(briefing) || name, ...(briefing ? { input: briefing } : {}) };
    if (!result || !record) return { ...base, status: 'running' };
    if (record.kind === 'rejected') return { ...base, status: 'failed' };
    const status = record.result.status === 'returned' ? 'returned'
      : record.result.reviewDecision ? 'declined' : 'missing';
    return { ...base, title: record.execution.task, status };
  }
  const input = args && Object.keys(args).length ? JSON.stringify(args) : undefined;
  return { id, name, title: name, ...(input ? { input } : {}),
    status: !result ? 'running' : result.status === 'error' ? 'failed' : 'returned' };
}

function firstLine(text: string) {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? '';
}
