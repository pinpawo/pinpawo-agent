import type { BaseMessage } from '@langchain/core/messages';
import type { SubagentInput, SubagentResult, SubagentToolLifecycleEvent } from '../types/subagent';
import { createAgent } from 'langchain';
import { SubagentToolEventTracker } from './toolEventTracker';
import { isToolReviewRequiredError } from '../agent/orchestrator/review/toolReviewSignal';

const DEFAULT_SUBAGENT_MAX_ITERATIONS = 12;

const SUBAGENT_GOVERNING_PROMPT = [
  '你是任务执行器，负责精确完成分配给你的任务。',
  '',
  '## 工作流程',
  '1. **理解任务**：仔细阅读任务描述，识别所有需要完成的步骤。',
  '2. **制定计划**：如果任务包含多个步骤，先在心里列出步骤清单。',
  '3. **逐步执行**：按计划依次完成每个步骤。',
  '4. **核验完整性**：所有步骤都完成后，再返回结果。',
  '',
  '## 注意',
  '- 不要只完成部分步骤就返回——确保任务描述中的每一项都已处理。',
  '- 选择工具时优先使用语义最具体的工具；shell/run_shell 这类通用命令执行工具只作为兜底。',
  '- 返回明确、具体的结果。',
].join('\n');

function readMessagesFromValuesChunk(chunk: unknown): BaseMessage[] | null {
  if (
    typeof chunk === 'object'
    && chunk !== null
    && 'messages' in chunk
    && Array.isArray((chunk as { messages?: unknown }).messages)
  ) {
    return (chunk as { messages: BaseMessage[] }).messages;
  }
  return null;
}

function isSubagentToolLifecycleEvent(payload: unknown): payload is SubagentToolLifecycleEvent {
  const event = payload && typeof payload === 'object'
    ? (payload as { event?: unknown }).event
    : null;
  return Boolean(
    payload
      && typeof payload === 'object'
      && 'event' in payload
      && 'name' in payload
      && (
        event === 'on_tool_start'
        || event === 'on_tool_event'
        || event === 'on_tool_end'
        || event === 'on_tool_error'
      )
      && typeof (payload as { name?: unknown }).name === 'string',
  );
}

export async function createSubagent(input: SubagentInput): Promise<SubagentResult> {
  const systemPrompt = [SUBAGENT_GOVERNING_PROMPT, ...input.instructions].join('\n\n');
  const maxIterations = input.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;

  const agent = createAgent({
    model: input.model,
    tools: input.tools,
    systemPrompt,
    ...(input.checkpoint ? { checkpointer: input.checkpoint } : {}),
  });

  let latestMessages = input.messages;
  const toolEvents = new SubagentToolEventTracker();
  const emitToolEvent = async (event: SubagentToolLifecycleEvent) => {
    if (event.event === 'on_tool_error' && isToolReviewRequiredError(event.error)) {
      throw event.error;
    }
    const operation = event.operation ?? input.operations?.[event.name];
    await input.onToolEvent?.(toolEvents.accept(operation ? { ...event, operation } : event));
  };
  const finishToolEvents = async (outcome: 'completed' | 'failed', error?: unknown) => {
    for (const event of toolEvents.finishActive(outcome, error)) {
      await input.onToolEvent?.(event);
    }
  };

  try {
    const stream = await agent.stream(
      { messages: input.messages },
      {
        ...input.runnableConfig,
        signal: input.signal,
        recursionLimit: maxIterations,
        streamMode: ['values', 'tools'],
      },
    );

    for await (const chunk of stream) {
      if (Array.isArray(chunk) && chunk.length === 2) {
        const [mode, payload] = chunk as [string, unknown];
        if (mode === 'values') {
          latestMessages = readMessagesFromValuesChunk(payload) ?? latestMessages;
        }
        if (mode === 'tools' && isSubagentToolLifecycleEvent(payload)) {
          await emitToolEvent(payload);
        }
        continue;
      }

      latestMessages = readMessagesFromValuesChunk(chunk) ?? latestMessages;
    }

    await finishToolEvents('completed');
    return {
      messages: latestMessages,
      completionReason: 'natural',
    };
  } catch (err) {
    const isLimitReached = err instanceof Error
      && (
        (typeof (err as { lc_error_code?: unknown }).lc_error_code === 'string'
          && (err as { lc_error_code?: string }).lc_error_code === 'GRAPH_RECURSION_LIMIT')
        || /GRAPH_RECURSION_LIMIT|Recursion limit of \d+ reached/i.test(err.message)
      );

    if (isLimitReached) {
      await finishToolEvents('failed', err);
      return {
        messages: latestMessages,
        completionReason: 'limit_reached',
      };
    }

    await finishToolEvents('failed', err);
    throw err;
  }
}
