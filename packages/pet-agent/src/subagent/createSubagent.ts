import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import type { SubagentInput, SubagentResult, SubagentToolEvent } from '../types/subagent';
import { createAgent, createMiddleware } from 'langchain';
import { SubagentToolEventTracker } from './toolEventTracker';

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

function isSubagentToolEvent(payload: unknown): payload is SubagentToolEvent {
  return Boolean(
    payload
      && typeof payload === 'object'
      && 'event' in payload
      && 'name' in payload
      && typeof (payload as { event?: unknown }).event === 'string'
      && typeof (payload as { name?: unknown }).name === 'string',
  );
}

type ToolImageArtifact = { images?: Array<{ dataUrl: string }> };

function readToolImages(message: BaseMessage): Array<{ dataUrl: string }> | null {
  if (message._getType() !== 'tool') return null;
  const artifact = (message as ToolMessage).artifact as ToolImageArtifact | undefined;
  return artifact?.images?.length ? artifact.images : null;
}

/**
 * 把"最后一条 human 消息之后"出现的工具图片 artifact(`{ images: [...] }`)转成
 * 待注入的 HumanMessage(image_url)。注入后这些工具结果就落在新 human 消息之前,
 * 因此再次调用时不会重复注入(天然去重)。纯函数,便于单测。
 */
export function buildToolImageRelayMessages(messages: BaseMessage[]): HumanMessage[] {
  let lastHuman = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?._getType() === 'human') {
      lastHuman = i;
      break;
    }
  }
  const injected: HumanMessage[] = [];
  for (let i = lastHuman + 1; i < messages.length; i += 1) {
    const images = readToolImages(messages[i]!);
    if (!images) continue;
    injected.push(new HumanMessage({
      content: [
        { type: 'text', text: '以下是工具返回的图片(如网页截图),请据此理解当前页面内容:' },
        ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } })),
      ],
    }));
  }
  return injected;
}

/**
 * 模型支持多模态时启用:每次模型调用前,把工具图片注入为 HumanMessage,让模型"看"到图片。
 */
function buildToolImageRelayMiddleware() {
  return createMiddleware({
    name: 'ToolImageRelay',
    beforeModel: (state) => {
      const injected = buildToolImageRelayMessages((state as { messages: BaseMessage[] }).messages);
      return injected.length ? { messages: injected } : undefined;
    },
  });
}

export async function createSubagent(input: SubagentInput): Promise<SubagentResult> {
  const systemPrompt = [SUBAGENT_GOVERNING_PROMPT, ...input.instructions].join('\n\n');
  const maxIterations = input.maxIterations ?? DEFAULT_SUBAGENT_MAX_ITERATIONS;

  const agent = createAgent({
    model: input.model,
    tools: input.tools,
    systemPrompt,
    ...(input.multimodal ? { middleware: [buildToolImageRelayMiddleware()] } : {}),
  });

  let latestMessages = input.messages;
  const toolEvents = new SubagentToolEventTracker();
  const emitToolEvent = async (event: SubagentToolEvent) => {
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
        if (mode === 'tools' && isSubagentToolEvent(payload)) {
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
