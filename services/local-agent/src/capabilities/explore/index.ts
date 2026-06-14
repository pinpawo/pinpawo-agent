import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type {
  AgentCapability,
  ContextPolicyContext,
  OrchestrationDecisionStructuredOutputConfig,
  SubagentResult,
} from '@pinpawo/pet-agent';
import { z } from 'zod';

const DEFAULT_EXPLORE_TOOLKITS = [
  'bash',
  'browser',
  'github',
  'gmail',
] as const;

export type ExploreResult = {
  status: 'progress' | 'completed';
  summary: string;
  nextSteps: string[];
};

export type ExploreCapabilityOptions = {
  structuredOutput?: OrchestrationDecisionStructuredOutputConfig;
};

export const exploreResultSchema = z.object({
  status: z.enum(['progress', 'completed']),
  summary: z.string().min(1),
  nextSteps: z.array(z.string().min(1)),
});

const exploreKnowledgeIngestSchema = z.object({
  summary: z.string().min(1),
});

const EXPLORE_CONTEXT_COMPRESSION_RATIO = 0.75;
const EXPLORE_FALLBACK_COMPRESSION_BUDGET_TOKENS = 24_000;
const EXPLORE_COMPRESS_KEEP_RECENT_TOOL_RESULTS = 2;
const EXPLORE_COMPRESS_MIN_TOOL_CHARS = 800;
const EXPLORE_SUMMARY_TRANSCRIPT_MAX_CHARS = 18_000;
const EXPLORE_SUMMARY_MESSAGE_MAX_CHARS = 2_000;
const EXPLORE_RAW_EVICTED = '[explore raw tool output evicted after ingest]';

function clipText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function readMessageText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .join('');
}

function readPinpawoMetadata(message: BaseMessage): Record<string, unknown> | null {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return pinpawo && typeof pinpawo === 'object'
    ? pinpawo as Record<string, unknown>
    : null;
}

function mergePinpawoMetadata(
  message: BaseMessage,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(message.additional_kwargs?.pinpawo && typeof message.additional_kwargs.pinpawo === 'object'
      ? message.additional_kwargs.pinpawo as Record<string, unknown>
      : {}),
    ...patch,
  };
}

function readExploreSummary(message: BaseMessage): string | null {
  const summary = readPinpawoMetadata(message)?.exploreSummary;
  return typeof summary === 'string' && summary.trim() ? summary.trim() : null;
}

function readLatestExploreSummary(messages: BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = readPinpawoMetadata(messages[index]);
    if (metadata?.exploreIngestFailed === true) return null;
    const summary = readExploreSummary(messages[index]);
    if (summary) return summary;
  }
  return null;
}

function createExploreSummaryMessage(summary: string): AIMessage {
  return new AIMessage({
    content: ['Explore summary:', '', summary.trim()].join('\n'),
    additional_kwargs: {
      pinpawo: {
        exploreSummary: summary.trim(),
      },
    },
  });
}

function readToolCallSummary(message: BaseMessage): string {
  const record = message as BaseMessage & {
    tool_calls?: unknown;
    additional_kwargs?: { tool_calls?: unknown };
  };
  const toolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : Array.isArray(record.additional_kwargs?.tool_calls)
      ? record.additional_kwargs.tool_calls
      : [];

  return toolCalls
    .map((call) => {
      if (!call || typeof call !== 'object') return null;
      const item = call as Record<string, unknown>;
      const name = typeof item.name === 'string'
        ? item.name
        : typeof item.function === 'object' && item.function && 'name' in item.function && typeof item.function.name === 'string'
          ? item.function.name
          : 'tool';
      const args = 'args' in item
        ? item.args
        : typeof item.function === 'object' && item.function && 'arguments' in item.function
          ? item.function.arguments
          : null;
      return `${name} ${clipText(JSON.stringify(args ?? {}), 600)}`;
    })
    .filter((item): item is string => Boolean(item))
    .join('\n');
}

function readMessageStatus(message: BaseMessage): ExploreResult['status'] | null {
  const pinpawo = message.additional_kwargs?.pinpawo;
  if (!pinpawo || typeof pinpawo !== 'object') return null;

  const metadata = pinpawo as Record<string, unknown>;
  if (metadata.announce === 'completed' || metadata.completionReason === 'natural') {
    return 'completed';
  }
  if (metadata.announce === 'progress' || typeof metadata.completionReason === 'string') {
    return 'progress';
  }
  return null;
}

function readLatestStatus(messages: BaseMessage[]): ExploreResult['status'] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const status = readMessageStatus(messages[index]);
    if (status) return status;
  }
  return 'completed';
}

export function readExploreResult(messages: BaseMessage[]): ExploreResult | null {
  const summary = readLatestExploreSummary(messages);
  return summary ? { status: readLatestStatus(messages), summary, nextSteps: [] } : null;
}

function buildExploreSummaryTranscript(messages: BaseMessage[]) {
  const lines: string[] = [];
  let totalLength = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = readMessageText(message);
    const toolCalls = readToolCallSummary(message);
    if (!text && !toolCalls) continue;

    const entry = [
      `[${message._getType()}]`,
      toolCalls ? `tool_calls:\n${toolCalls}` : null,
      text ? `content:\n${clipText(text, EXPLORE_SUMMARY_MESSAGE_MAX_CHARS)}` : null,
    ].filter(Boolean).join('\n');

    totalLength += entry.length;
    if (totalLength > EXPLORE_SUMMARY_TRANSCRIPT_MAX_CHARS) break;
    lines.unshift(entry);
  }

  return lines.join('\n\n');
}

async function ingestExploreKnowledge(params: {
  model: BaseChatModel;
  structuredOutput?: OrchestrationDecisionStructuredOutputConfig;
  previousSummary: string | null;
  evidence: string;
  reason: 'context_pressure' | 'finalize';
}): Promise<string> {
  const evidence = clipText(params.evidence, EXPLORE_SUMMARY_TRANSCRIPT_MAX_CHARS);
  if (!evidence.trim()) {
    throw new Error('explore ingest has no new evidence');
  }

  const model = params.model.withStructuredOutput(exploreKnowledgeIngestSchema, {
    name: 'explore_knowledge_ingest',
    ...(params.structuredOutput?.method ? { method: params.structuredOutput.method } : {}),
    ...(typeof params.structuredOutput?.strict === 'boolean' ? { strict: params.structuredOutput.strict } : {}),
  });
  const result = await model.invoke([
    new SystemMessage([
      '你是 explore capability 的知识 ingest 模块。',
      '你的任务是维护一份短小、可恢复现场的探索摘要，而不是复制工具流水账。',
      '输入包括上一版 summary 和新增 evidence。你必须更新 summary，必要时修正旧结论。',
      'summary 必须用 Markdown，包含：目标、已查看文件、关键知识点 / 概念、已确认事实、未确认 / 风险、下一步。',
      'summary 要让下一轮 agent 不重复探索已看过的内容。',
      '不要复制大段原始工具输出。',
      '不要编造未查看过的文件、URL、issue、PR 或命令结果。',
    ].join('\n')),
    new HumanMessage([
      `触发原因：${params.reason}`,
      '上一版 summary：',
      params.previousSummary ?? '[无]',
      '新增 evidence：',
      evidence,
    ].join('\n\n')),
  ]);
  return result.summary.trim();
}

function buildFinalEvidence(messages: BaseMessage[]) {
  const transcript = buildExploreSummaryTranscript(messages);
  return transcript ? `[finalize]\n${transcript}` : '';
}

function buildExploreIngestFailureMessage(error: unknown) {
  return new AIMessage({
    content: [
      'explore 知识摘要更新失败，已停止继续探索。',
      `错误：${error instanceof Error ? error.message : String(error)}`,
      '未使用自由文本或低质量兜底摘要替代结构化 ingest 结果。',
    ].join('\n'),
    additional_kwargs: {
      pinpawo: {
        exploreIngestFailed: true,
      },
    },
  });
}

function replaceToolMessageContent(
  message: ToolMessage,
  content: string,
  pinpawoPatch: Record<string, unknown> = {},
): ToolMessage {
  return new ToolMessage({
    id: message.id,
    name: message.name,
    content,
    tool_call_id: message.tool_call_id,
    status: message.status,
    artifact: message.artifact,
    metadata: message.metadata,
    additional_kwargs: {
      ...message.additional_kwargs,
      pinpawo: mergePinpawoMetadata(message, pinpawoPatch),
    },
    response_metadata: message.response_metadata,
  });
}

function buildExploreCompressionBudget(ctx: ContextPolicyContext): number {
  const contextWindowTokens = ctx.contextWindowTokens;
  if (contextWindowTokens && Number.isFinite(contextWindowTokens) && contextWindowTokens > 0) {
    return Math.max(1, Math.floor(contextWindowTokens * EXPLORE_CONTEXT_COMPRESSION_RATIO));
  }
  return EXPLORE_FALLBACK_COMPRESSION_BUDGET_TOKENS;
}

function isCompressedExploreToolOutput(message: ToolMessage) {
  return readPinpawoMetadata(message)?.exploreRawEvicted === true;
}

function collectCompressibleToolResultIndexes(messages: BaseMessage[]): number[] {
  const toolIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter((item): item is { message: ToolMessage; index: number } => ToolMessage.isInstance(item.message));
  const protectedIndexes = new Set(
    toolIndexes.slice(-EXPLORE_COMPRESS_KEEP_RECENT_TOOL_RESULTS).map((item) => item.index),
  );

  return toolIndexes
    .filter(({ message, index }) => {
      if (protectedIndexes.has(index)) return false;
      if (message.status === 'error') return false;
      const text = readMessageText(message);
      if (isCompressedExploreToolOutput(message)) return false;
      return text.length >= EXPLORE_COMPRESS_MIN_TOOL_CHARS;
    })
    .map((item) => item.index);
}

function buildContextPressureEvidence(messages: BaseMessage[], toolIndexes: number[]) {
  const selected = new Set(toolIndexes);
  const lines: string[] = [];
  let totalLength = 0;

  for (const [index, message] of messages.entries()) {
    if (!selected.has(index)) continue;
    const text = readMessageText(message);
    if (!text) continue;
    const entry = [
      `[tool_result] ${typeof (message as ToolMessage).name === 'string' ? (message as ToolMessage).name : 'tool'}`,
      clipText(text, EXPLORE_SUMMARY_MESSAGE_MAX_CHARS),
    ].join('\n');
    totalLength += entry.length;
    if (totalLength > EXPLORE_SUMMARY_TRANSCRIPT_MAX_CHARS) break;
    lines.push(entry);
  }

  return lines.length > 0 ? `[context_pressure]\n${lines.join('\n\n')}` : '';
}

function replaceCompressedToolOutputs(
  messages: BaseMessage[],
  toolIndexes: number[],
  summary: string,
): BaseMessage[] {
  if (toolIndexes.length === 0) return messages;
  const summaryIndex = toolIndexes[toolIndexes.length - 1];
  const selected = new Set(toolIndexes);
  return messages.map((message, index) => {
    if (!selected.has(index) || !ToolMessage.isInstance(message)) return message;
    const content = index === summaryIndex
      ? `${EXPLORE_RAW_EVICTED}\n\nExplore summary:\n\n${summary.trim()}`
      : `${EXPLORE_RAW_EVICTED}\nSee the later compressed explore summary for findings.`;
    return replaceToolMessageContent(message, content, {
      exploreRawEvicted: true,
      ...(index === summaryIndex ? { exploreSummary: summary.trim() } : {}),
    });
  });
}

export function createExploreCapability(options: ExploreCapabilityOptions = {}): AgentCapability {
  return {
    name: 'explore',
    description: [
      '通用探索、调查、资料检索和代码库理解 capability。',
      '适合大量阅读、搜索、检查上下文、梳理证据、先探索再决定下一步的任务。',
      '只做只读调查和总结，不修改文件、不执行外部真实副作用。',
    ].join(' '),
    createRuntime: async (context) => {
      const available = new Set(context.availableToolkits?.map((item) => item.name) ?? []);
      const ingestModel = context.models.observe ?? context.models.subagent ?? context.models.act;
      let currentSummary = readLatestExploreSummary(context.messages);
      const rewriteUnderContextPressure = async (
        messages: BaseMessage[],
        ctx: ContextPolicyContext,
      ): Promise<BaseMessage[]> => {
        const budgetTokens = buildExploreCompressionBudget(ctx);
        if (ctx.estimateMessagesTokens(messages) <= budgetTokens) {
          return messages;
        }
        const toolIndexes = collectCompressibleToolResultIndexes(messages);
        if (toolIndexes.length === 0) {
          return messages;
        }
        const evidence = buildContextPressureEvidence(messages, toolIndexes);
        if (!evidence.trim()) {
          return messages;
        }
        const summary = await ingestExploreKnowledge({
          model: ingestModel,
          structuredOutput: options.structuredOutput,
          previousSummary: currentSummary,
          evidence,
          reason: 'context_pressure',
        });
        currentSummary = summary;
        return replaceCompressedToolOutputs(messages, toolIndexes, summary);
      };
      const ingestFinalResult = async (result: SubagentResult): Promise<SubagentResult> => {
        const evidence = buildFinalEvidence(result.messages);
        if (!evidence.trim()) return result;
        try {
          const summary = await ingestExploreKnowledge({
            model: ingestModel,
            structuredOutput: options.structuredOutput,
            previousSummary: currentSummary,
            evidence,
            reason: 'finalize',
          });
          currentSummary = summary;
          return {
            ...result,
            messages: [
              ...result.messages,
              createExploreSummaryMessage(summary),
            ],
          };
        } catch (error) {
          return {
            ...result,
            completionReason: 'error',
            messages: [
              ...result.messages,
              buildExploreIngestFailureMessage(error),
            ],
          };
        }
      };
      return {
        uses: DEFAULT_EXPLORE_TOOLKITS.filter((name) => available.has(name)),
        contextPolicy: {
          rewriteAsync: rewriteUnderContextPressure,
        },
        instructions: [
          '你是通用探索 capability。只读取、检查、搜索、观察和总结上下文。',
          '不要修改文件，不要提交、推送、删除、写入、发送消息、发布内容，或执行任何外部真实副作用。',
          '使用可用工具在执行过程中自行规划探索；createRuntime 阶段不做额外模型规划。',
          '优先先确认候选范围，再读取详细内容；避免无界浏览或无目的扫描。',
          '上下文足够时会保留完整工具输出；只有接近上下文预算时，较早的大型工具输出才会被知识摘要替换。',
          '结论必须包含简洁探索摘要、已查看文件列表、关键发现、证据引用（文件路径、URL、issue/PR 编号或命令输出来源）和建议下一步。',
        ],
        middleware: {
          afterRun: ingestFinalResult,
        },
        readResult: readExploreResult,
      };
    },
    resultSchema: exploreResultSchema,
  };
}
