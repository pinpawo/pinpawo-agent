import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { closureInput } from './supervisor-delivery-closure';
import { supervisorDeliveryClosureDataset } from './datasets/supervisor-delivery-closure';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../src/agent/messages';

export type HistoryMode = 'entry' | 'boundary' | 'resume';
export type HistoryVariant = 'baseline' | 'prompt' | 'projection';
export function toolHistoryInput(mode: HistoryMode, count: number, id: string) {
  const example = supervisorDeliveryClosureDataset.cases.find(c => c.name === (mode === 'boundary' ? 'pending-report' : 'entry-split'))!;
  const input = closureInput(example.input, id);
  const history: BaseMessage[] = [];
  for (let i = 0; i < count; i++) {
    const previous = closureInput({
      goal: `复核历史任务 H-${i} 的配置。`, capability: 'studio_review',
      task: `独立复核历史任务 H-${i}，返回审阅结论。`,
      evidence: `历史任务 H-${i} 的配置已核验，结论通过。文件 scripts 与构建入口一致。`,
    }, `history-${i}`);
    const result = previous.messages[2] as ToolMessage;
    (result.artifact as { taskId: string }).taskId = `history-task-${i}`;
    history.push(...previous.messages.slice(1));
  }
  if (mode === 'resume') {
    return { input: { ...input,
      state: { ...input.state, plan: [
        { id: 'current', capability: 'studio_review', objective: '独立核验三个配置文件并返回审阅结论。', status: 'pending' as const },
        { id: 'next', capability: 'studio_reporting', objective: '提交 T-NEW 的完整审阅结论。', status: 'pending' as const },
      ] },
      messages: [...input.messages, ...history, new HumanMessage('继续')],
    }, expected: example.expected };
  }
  return { input: { ...input, messages: [...history, ...input.messages] }, expected: example.expected };
}

/** Evaluation-only projection: preserve facts, remove executable assistant examples.
 * Apply only to canonical history ids, never new calls/errors in the current loop.
 */
export function projectHistoryEvidence(messages: readonly BaseMessage[], historicalCallIds: ReadonlySet<string>): BaseMessage[] {
  return messages.map(message => {
    if (AIMessage.isInstance(message) && message.tool_calls?.length === 1
      && message.tool_calls[0].name === 'delegate_capability'
      && historicalCallIds.has(message.tool_calls[0].id!)) {
      const call = message.tool_calls[0];
      return setAgentMessageMetadata(new HumanMessage({ id: message.id, content: JSON.stringify({
        type: 'capability_execution_record', authority: 'none', source: 'root_history',
        callId: call.id, dispatch: call.args, content: message.content,
      }) }), getAgentMessageMetadata(message));
    }
    if (ToolMessage.isInstance(message) && message.name === 'delegate_capability'
      && historicalCallIds.has(message.tool_call_id)) {
      return setAgentMessageMetadata(new HumanMessage({ id: message.id, content: JSON.stringify({
        type: 'capability_execution_result', authority: 'none', source: 'root_history',
        callId: message.tool_call_id, status: message.status, content: message.content,
      }) }), getAgentMessageMetadata(message));
    }
    return message;
  });
}

/** Ablate only the added tool-scope paragraph, leaving all other current guidance intact. */
export function withoutToolScope(messages: readonly BaseMessage[]): BaseMessage[] {
  return messages.map(message => {
    if (!SystemMessage.isInstance(message) || typeof message.content !== 'string') return message;
    const paragraphs = message.content.split('\n\n');
    const filtered = paragraphs.filter(p => !p.startsWith('只能调用本轮实际提供的工具；'));
    if (filtered.length !== paragraphs.length - 1) throw new Error('Tool-scope ablation must remove exactly one paragraph.');
    return new SystemMessage({ content: filtered.join('\n\n') });
  });
}
