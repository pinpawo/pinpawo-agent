/**
 * Local WebSocket server for TUI ↔ run process communication.
 *
 * Runs inside the `run` process. TUI connects via ws://127.0.0.1:<port>.
 * Protocol matches the App WS relay format so both paths share the same
 * message types.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import { type AgentCapability, type AgentToolkit } from '@pinpawo/pet-agent';
import type { AgentLlmConfig } from './agentConfig';
import { loadAgentContext } from './contextLoader';
import {
  getCachedCapabilityAvailability,
  refreshCapability,
  type CapabilityAvailabilityRecord,
  refreshToolkit,
  type ToolkitAvailabilityRecord,
} from './capabilities/capabilityAvailability';
import { FileSaver } from './fileSaver';
import { buildLocalChatAgentInput } from './agentChannel';
import { LocalAgentGraphService } from './agentGraphService';
import type { LoadedUserCapability } from './capabilityLoader';
import { authorizeShellPattern, clearSessionAuthorizations } from './sessionAuthorizations';
import {
  buildTuiChatThreadId,
  formatInterruptPrompt,
  normalizeInterruptResume,
  readPendingInterrupt,
  readShellReviewCommand,
  type ChatRequestMessage,
  type StudioRequestMessage,
  type ToolLogPhase,
} from './chatInterface';
import { readFirstHumanReviewDecision, type HumanReviewDecision } from '@pinpawo/pet-agent';
import { clearAgentRunActivity, readActiveToolHealthFields, recordAgentRunActivity, recordToolActivity } from './toolActivityState';
import {
  buildStudioForTurn,
  StudioNotConfiguredError,
} from './studio/studioRuntime';
import {
  createPendingReviewSlot,
  rejectReview,
  resolveReview,
  type PendingReviewSlot,
} from './studio/studioBridge';

export type AgentStats = {
  startedAt: string;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
};

export type LocalServerDeps = {
  actorId: string;
  actorName?: string;
  llmConfig: AgentLlmConfig;
  localTools: StructuredTool[];
  localToolkitDefinitions?: AgentToolkit[];
  localToolkits?: AgentToolkit[];
  pluginTools: StructuredTool[];
  localCapabilityDefinitions?: AgentCapability[];
  localCapabilities?: AgentCapability[];
  userCapabilityDefinitions?: LoadedUserCapability[];
  userCapabilities?: LoadedUserCapability[];
  getStats: () => AgentStats;
};

const chatCheckpointer = new FileSaver(
  resolve(homedir(), '.pinpawo', 'checkpoints-tui.json'),
);
const sessionStatePath = resolve(homedir(), '.pinpawo', 'tui-sessions.json');

const chatGraphService = new LocalAgentGraphService();

/**
 * Per-ws HITL 答复槽。Studio 模式下,pet 触发 humanReviewer 时,humanReviewer 把
 * promise resolver 寄存在这里;chat_request handler 收到 resume 字段时,
 * 走 additive 分支调 resolveReview() 喂答复。chat 无 Studio 活跃时此 map 为空,
 * 现有 chat 路径行为 0 变化。
 */
const studioPendingReviews = new Map<WebSocket, PendingReviewSlot>();

function getOrCreateStudioReviewSlot(ws: WebSocket): PendingReviewSlot {
  let slot = studioPendingReviews.get(ws);
  if (!slot) {
    slot = createPendingReviewSlot();
    studioPendingReviews.set(ws, slot);
  }
  return slot;
}

/**
 * 从 chat_request 的 message + resume 字段解码出 HumanReviewDecision。
 * 用于 Studio HITL 答复路由:
 * - msg.resume 显式提供 → 解析
 * - "/allow" 前缀 → approve
 * - 非空 message → respond
 * - 否则 → reject
 */
function decodeStudioDecision(msg: ChatRequestMessage): HumanReviewDecision | null {
  if (msg.resume !== undefined) {
    const decoded = readFirstHumanReviewDecision(msg.resume);
    if (decoded) return decoded;
  }
  const text = (msg.message ?? '').trim();
  if (text.startsWith('/allow')) {
    return { type: 'approve' };
  }
  if (text) {
    return { type: 'respond', message: text };
  }
  return { type: 'reject' };
}
const INTERNAL_AI_STREAM_NODES = new Set([
  'capabilityDiscovery',
  'userIntentDecision',
  'delegationOutcomeDecision',
]);
const INTERRUPT_FORCE_REPLY_MS = 1800;

function loadSessionSuffixes() {
  try {
    if (!existsSync(sessionStatePath)) {
      return new Map<string, string>();
    }
    const raw = readFileSync(sessionStatePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string' && Boolean(entry[1]),
      ),
    );
  } catch {
    return new Map<string, string>();
  }
}

function saveSessionSuffixes(suffixes: Map<string, string>) {
  try {
    mkdirSync(resolve(homedir(), '.pinpawo'), { recursive: true });
    writeFileSync(
      sessionStatePath,
      JSON.stringify(Object.fromEntries(suffixes), null, 2),
      'utf-8',
    );
  } catch {
    // best-effort persistence only
  }
}

const sessionSuffixes = loadSessionSuffixes();

function ensureSessionSuffix(petId: string) {
  let suffix = sessionSuffixes.get(petId);
  if (!suffix) {
    suffix = randomUUID().slice(0, 8);
    sessionSuffixes.set(petId, suffix);
    saveSessionSuffixes(sessionSuffixes);
  }
  return suffix;
}

function getChatThreadId(petId: string) {
  const suffix = ensureSessionSuffix(petId);
  return buildTuiChatThreadId({ petId, sessionSuffix: suffix });
}

async function resetChatSession(petId: string) {
  const previousThreadId = getChatThreadId(petId);
  sessionSuffixes.set(petId, randomUUID().slice(0, 8));
  saveSessionSuffixes(sessionSuffixes);
  clearSessionAuthorizations(previousThreadId);
  await chatCheckpointer.deleteThread(previousThreadId);
}

function buildChatSetup(deps: LocalServerDeps, ctx: Awaited<ReturnType<typeof loadAgentContext>>) {
  return buildLocalChatAgentInput({
    context: ctx,
    userMessage: '',
    llmConfig: deps.llmConfig,
    tools: deps.pluginTools,
    toolkits: deps.localToolkits,
    extraCapabilities: deps.localCapabilities,
    threadId: getChatThreadId(deps.actorId),
    dryRun: false,
    checkpoint: chatCheckpointer,
    userCapabilities: deps.userCapabilities,
  });
}

function readSnapshotMessages(snapshot: Awaited<ReturnType<LocalAgentGraphService['getState']>>) {
  const values = (snapshot as { values?: { messages?: BaseMessage[] } }).values;
  return Array.isArray(values?.messages) ? values.messages : [];
}

function readHistoryMessages(messages: BaseMessage[]) {
  return messages.flatMap((message) => {
    const type = message._getType();
    if (type !== 'human' && type !== 'ai') {
      return [];
    }
    if (type === 'ai') {
      const pinpawo = message.additional_kwargs?.pinpawo;
      if (pinpawo && typeof pinpawo === 'object' && 'lane' in pinpawo) {
        return [];
      }
    }
    const text = readFinalMessageText(message);
    if (!text) {
      return [];
    }
    return [{
      role: type === 'human' ? 'user' : 'assistant',
      text,
    }];
  });
}

type InflightRequest = {
  requestId: string;
  controller: AbortController;
  interruptedSent?: boolean;
  interruptTimer?: ReturnType<typeof setTimeout>;
};

const inflightRequests = new Map<WebSocket, InflightRequest>();

function clearInflightTimer(inflight: InflightRequest) {
  if (inflight.interruptTimer) {
    clearTimeout(inflight.interruptTimer);
    inflight.interruptTimer = undefined;
  }
}

function clearInflightRequest(ws: WebSocket, inflight: InflightRequest) {
  clearInflightTimer(inflight);
  if (inflightRequests.get(ws) === inflight) {
    inflightRequests.delete(ws);
  }
}

function sendInterrupted(ws: WebSocket, inflight: InflightRequest) {
  if (inflight.interruptedSent) {
    return;
  }
  inflight.interruptedSent = true;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'interrupted',
      requestId: inflight.requestId,
      message: 'interrupted',
    }));
  }
}

function interruptInflightRequest(ws: WebSocket, inflight: InflightRequest) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'interrupting',
      requestId: inflight.requestId,
      message: 'interrupting',
    }));
  }
  inflight.controller.abort();
  if (inflight.interruptTimer) {
    return;
  }
  inflight.interruptTimer = setTimeout(() => {
    if (inflightRequests.get(ws) !== inflight || !inflight.controller.signal.aborted) {
      return;
    }
    sendInterrupted(ws, inflight);
    clearInflightRequest(ws, inflight);
    console.warn(`[local-server] force interrupted requestId=${inflight.requestId}`);
  }, INTERRUPT_FORCE_REPLY_MS);
}

function readFinalMessageText(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function readMessageChunkText(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
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
  return '';
}

function readStreamNode(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || !('langgraph_node' in metadata)) {
    return null;
  }
  const node = metadata.langgraph_node;
  return typeof node === 'string' ? node : null;
}

function isLaneTaggedAiMessage(message: BaseMessage) {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return Boolean(pinpawo && typeof pinpawo === 'object' && 'lane' in pinpawo);
}

type StreamToolsPayload = {
  event: 'on_tool_start' | 'on_tool_event' | 'on_tool_end' | 'on_tool_error';
  toolCallId?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  data?: unknown;
};

function maybeTrimForLog(value: string | undefined, max = 300) {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function stringifyToolData(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  // LangChain message objects (e.g. ToolMessage) carry their text in .content
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
        .join('');
    }
  }
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value);
  }
}

function isHumanReviewInterruptError(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  const interrupts = Array.isArray(record.interrupts)
    ? record.interrupts
    : Array.isArray(record.__interrupt__)
      ? record.__interrupt__
      : [];
  return interrupts.some((interrupt) => {
    const payload = interrupt && typeof interrupt === 'object' && 'value' in interrupt
      ? (interrupt as { value?: unknown }).value
      : interrupt;
    if (!payload || typeof payload !== 'object') {
      return false;
    }
    const payloadRecord = payload as Record<string, unknown>;
    return payloadRecord.kind === 'human_review'
      || (Array.isArray(payloadRecord.actionRequests) && Array.isArray(payloadRecord.reviewConfigs));
  });
}

function isToolProtocolHistoryError(value: unknown): boolean {
  const text = value instanceof Error
    ? `${value.name}\n${value.message}\n${value.stack ?? ''}`
    : String(value ?? '');
  return text.includes('INVALID_TOOL_RESULTS')
    || text.includes("An assistant message with 'tool_calls' must be followed by tool messages")
    || text.includes('insufficient tool messages following tool_calls message');
}

function emitToolLog(ws: WebSocket, requestId: string, payload: StreamToolsPayload) {
  const phase: ToolLogPhase = payload.event === 'on_tool_start'
    ? 'start'
    : payload.event === 'on_tool_end'
      ? 'end'
      : payload.event === 'on_tool_error'
        ? 'error'
        : 'event';
  const input = payload.input !== undefined ? stringifyToolData(payload.input) : undefined;
  const output = payload.output !== undefined
    ? stringifyToolData(payload.output)
    : payload.data !== undefined
      ? stringifyToolData(payload.data)
      : undefined;
  const error = payload.error !== undefined ? stringifyToolData(payload.error) : undefined;

  if (phase === 'error' && isHumanReviewInterruptError(payload.error)) {
    recordToolActivity(payload.name, 'interrupt', requestId);
    console.log(`[local-server] tool_interrupt requestId=${requestId} tool=${payload.name}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'tool_log',
        requestId,
        phase: 'interrupt',
        toolName: payload.name,
        toolCallId: payload.toolCallId,
        input,
      }));
    }
    return;
  }

  recordToolActivity(payload.name, phase, requestId);

  console.log(
    `[local-server] tool_${phase} requestId=${requestId} tool=${payload.name}`
      + (input ? ` input=${maybeTrimForLog(input, 200)}` : '')
      + (error ? ` error=${maybeTrimForLog(error)}` : ''),
  );

  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({
    type: 'tool_log',
    requestId,
    phase,
    toolName: payload.name,
    toolCallId: payload.toolCallId,
    input,
    output,
    error,
  }));
}

async function handleStudioRequest(
  ws: WebSocket,
  msg: StudioRequestMessage,
  deps: LocalServerDeps,
) {
  const { requestId, userRequest } = msg;
  const conversationId = msg.conversationId ?? requestId;

  console.log(`[local-server] studio_request requestId=${requestId} userRequest="${userRequest.slice(0, 80)}"`);

  // 取消已有 inflight(避免跟 chat 重叠)
  const previousInflight = inflightRequests.get(ws);
  if (previousInflight) {
    clearInflightTimer(previousInflight);
    previousInflight.controller.abort();
  }

  const controller = new AbortController();
  const inflight: InflightRequest = { requestId, controller };
  inflightRequests.set(ws, inflight);

  // 重置 review slot(防止上一 turn 残留)
  const slot = getOrCreateStudioReviewSlot(ws);
  if (slot.current) {
    rejectReview(slot, new Error('superseded by new studio_request'));
  }

  const send = (envelope: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope));
    }
  };

  try {
    const { orchestrator } = await buildStudioForTurn({
      llmConfig: deps.llmConfig,
      capabilities: [
        ...(deps.localCapabilities ?? []),
        ...(deps.userCapabilities ?? []).map((u) => u.capability),
      ],
      tools: [...deps.pluginTools, ...deps.localTools],
      ownerUserId: null, // Phase 2 MVP: 纯本地,无服务端 owner 绑定
      bridge: { send, requestId, slot },
    });

    const result = await orchestrator.invoke({
      userRequest,
      conversationId,
      turnId: requestId,
      signal: controller.signal,
      onTurnEvent: (event) => {
        send({ type: 'studio_turn_event', requestId, event });
      },
      onToolEvent: (event) => {
        emitToolLog(ws, requestId, event as StreamToolsPayload);
      },
    });

    if (controller.signal.aborted) {
      send({ type: 'studio_error', requestId, message: 'aborted by client' });
      return;
    }

    if (result.outcome.outcome === 'done') {
      send({
        type: 'studio_response',
        requestId,
        outcome: 'done',
        reply: result.outcome.reply,
        finalDispatchId: result.outcome.finalDispatchId,
      });
    } else {
      send({
        type: 'studio_response',
        requestId,
        outcome: 'stopped',
        reply: result.outcome.reply,
        reason: result.outcome.reason,
      });
    }
  } catch (err) {
    if (err instanceof StudioNotConfiguredError) {
      send({
        type: 'studio_error',
        requestId,
        message: `Studio 未配置:${err.message}`,
      });
    } else {
      console.error(
        '[local-server] handleStudioRequest error:',
        err instanceof Error ? err.message : err,
      );
      send({
        type: 'studio_error',
        requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    if (slot.current) {
      rejectReview(slot, new Error('studio turn ended with unresolved review'));
    }
    if (inflightRequests.get(ws) === inflight) {
      inflightRequests.delete(ws);
    }
  }
}

async function handleChatRequest(ws: WebSocket, msg: ChatRequestMessage, deps: LocalServerDeps) {
  const { requestId, message } = msg;

  // ── Additive 分支:若 Studio 内 pet 正在等 HITL 答复,把这次 chat_request 解读为答复 ──
  // chat 路径无 Studio 活跃时(slot 为空),此分支不触发,行为与之前 100% 一致。
  const studioSlot = studioPendingReviews.get(ws);
  if (studioSlot?.current) {
    const decision = decodeStudioDecision(msg);
    if (decision) {
      console.log(
        `[local-server] route chat_request as studio HITL answer (reviewId=${studioSlot.current.reviewId}, decision=${decision.type})`,
      );
      resolveReview(studioSlot, decision);
      return;
    }
  }

  const threadId = getChatThreadId(deps.actorId);

  console.log(`[local-server] chat_request requestId=${requestId} message="${message.slice(0, 80)}"`);
  recordAgentRunActivity('thinking', requestId);

  const previousInflight = inflightRequests.get(ws);
  if (previousInflight) {
    clearInflightTimer(previousInflight);
    previousInflight.controller.abort();
    console.warn(`[local-server] abort previous inflight requestId=${previousInflight.requestId} before starting requestId=${requestId}`);
  }

  const controller = new AbortController();
  const inflight: InflightRequest = { requestId, controller };
  inflightRequests.set(ws, inflight);
  const isCurrent = () => inflightRequests.get(ws) === inflight && !controller.signal.aborted;
  const finishInterrupted = () => {
    if (!controller.signal.aborted) {
      return;
    }
    sendInterrupted(ws, inflight);
    clearInflightRequest(ws, inflight);
  };

  try {
    const ctx = await loadAgentContext(deps.actorId);
    if (!isCurrent()) {
      finishInterrupted();
      return;
    }

    const setup = buildChatSetup(deps, ctx);
    setup.input.messages = [
      ...setup.input.messages.slice(0, -1),
      new HumanMessage(message),
    ];
    setup.input.signal = controller.signal;
    const threadSnapshot = await chatGraphService.getState(setup);
    if (!isCurrent()) {
      finishInterrupted();
      return;
    }
    const pendingInterrupt = readPendingInterrupt(threadSnapshot);
    const pendingShellCommand = pendingInterrupt ? readShellReviewCommand(pendingInterrupt) : null;
    if (
      pendingShellCommand
      && message.trim().startsWith('/allow')
    ) {
      const requestedPattern = message.trim().slice('/allow'.length).trim();
      const authorizedPattern = authorizeShellPattern(
        threadId,
        requestedPattern || pendingShellCommand,
      );
      if (authorizedPattern && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'system_notice',
          requestId,
          message: `已授权本次会话中的 shell 模式：${authorizedPattern}`,
        }));
      }
    }
    const resumeValue = pendingInterrupt
      ? normalizeInterruptResume(pendingInterrupt, message, msg.resume)
      : undefined;
    const graphInput = pendingInterrupt
      ? chatGraphService.buildResumeCommand(resumeValue)
      : undefined;
    setup.input.onToolEvent = (event) => {
      if (isCurrent()) {
        emitToolLog(ws, requestId, event);
      }
    };

    let finalMessages: BaseMessage[] = [];
    let streamedReply = '';
    for await (const chunk of chatGraphService.stream(setup, graphInput)) {
      if (!isCurrent()) {
        finishInterrupted();
        return;
      }

      if (!Array.isArray(chunk)) {
        continue;
      }

      const [mode, payload] = chunk as [string, unknown];

      if (mode === 'messages' && Array.isArray(payload)) {
        const [message, metadata] = payload as [BaseMessage, Record<string, unknown> | undefined];
        if (message._getType() !== 'ai') {
          continue;
        }
        const streamNode = readStreamNode(metadata);
        if (streamNode && INTERNAL_AI_STREAM_NODES.has(streamNode)) {
          continue;
        }
        // Skip lane-tagged messages (subagent internal); only stream user-visible replies.
        if (isLaneTaggedAiMessage(message)) {
          continue;
        }
        const chunkText = readMessageChunkText(message);
        if (!chunkText || ws.readyState !== WebSocket.OPEN) {
          continue;
        }
        const token = chunkText.startsWith(streamedReply)
          ? chunkText.slice(streamedReply.length)
          : chunkText;
        if (!token) {
          continue;
        }
        streamedReply += token;
        recordAgentRunActivity('streaming', requestId);
        ws.send(JSON.stringify({
          type: 'chat_token',
          requestId,
          token,
        }));
        continue;
      }

      if (mode === 'tools' && payload && typeof payload === 'object' && 'event' in payload && 'name' in payload) {
        emitToolLog(ws, requestId, payload as StreamToolsPayload);
        continue;
      }

      if (mode === 'values' && payload && typeof payload === 'object' && 'messages' in payload) {
        finalMessages = ((payload as { messages?: BaseMessage[] }).messages ?? []);
        continue;
      }

      if (mode === 'values' && payload && typeof payload === 'object' && '__interrupt__' in payload) {
        const rawInterrupts = (payload as { __interrupt__?: unknown }).__interrupt__;
        const firstInterrupt = Array.isArray(rawInterrupts) ? rawInterrupts[0] : null;
        const interruptPayload = firstInterrupt
          && typeof firstInterrupt === 'object'
          && 'value' in firstInterrupt
          && firstInterrupt.value
          && typeof firstInterrupt.value === 'object'
          ? firstInterrupt.value as Record<string, unknown>
          : null;
        if (interruptPayload && ws.readyState === WebSocket.OPEN) {
          recordAgentRunActivity('waiting_human', requestId);
          clearInflightRequest(ws, inflight);
          ws.send(JSON.stringify({
            type: 'human_interrupt',
            requestId,
            prompt: formatInterruptPrompt(interruptPayload),
            payload: interruptPayload,
          }));
          console.log(`[local-server] human_interrupt requestId=${requestId}`);
          return;
        }
      }
    }
    if (!isCurrent()) {
      finishInterrupted();
      return;
    }

    setup.input.onToolEvent = undefined;
    const finalSnapshot = await chatGraphService.getState(setup);
    if (!isCurrent()) {
      finishInterrupted();
      return;
    }
    const finalInterrupt = readPendingInterrupt(finalSnapshot);
    if (finalInterrupt) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'human_interrupt',
          requestId,
          prompt: formatInterruptPrompt(finalInterrupt),
          payload: finalInterrupt,
        }));
      }
      recordAgentRunActivity('waiting_human', requestId);
      console.log(`[local-server] human_interrupt requestId=${requestId}`);
      clearInflightRequest(ws, inflight);
      return;
    }
    const finalReply = finalMessages.length > 0
      ? readFinalMessageText(finalMessages.at(-1) ?? {})
      : '';

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'chat_response',
        requestId,
        message: finalReply,
        mood: null,
        topic: null,
        tags: [],
      }));
    }
    clearInflightRequest(ws, inflight);
    clearAgentRunActivity(requestId);

    console.log(`[local-server] chat_response sent requestId=${requestId} reply="${finalReply.slice(0, 100)}"`);
  } catch (err) {
    const isStillCurrent = inflightRequests.get(ws) === inflight;
    const aborted = controller.signal.aborted
      || (err instanceof Error && err.name === 'AbortError');
    if (aborted) {
      console.warn(`[local-server] chat interrupted requestId=${requestId}`);
      sendInterrupted(ws, inflight);
      recordAgentRunActivity('interrupted', requestId, 2_500);
      clearInflightRequest(ws, inflight);
      return;
    }
    clearInflightRequest(ws, inflight);
    recordAgentRunActivity('error', requestId, 5_000);
    console.error('[local-server] chat error:', err instanceof Error ? (err.stack ?? err.message) : err);
    const recoveredFromToolProtocolError = isToolProtocolHistoryError(err);
    if (recoveredFromToolProtocolError) {
      try {
        await resetChatSession(deps.actorId);
        console.warn(`[local-server] reset TUI chat session after tool protocol error requestId=${requestId}`);
      } catch (resetError) {
        console.warn(
          '[local-server] failed to reset TUI chat session after tool protocol error:',
          resetError instanceof Error ? resetError.message : resetError,
        );
      }
    }
    if (isStillCurrent && ws.readyState === WebSocket.OPEN) {
      const message = err instanceof Error ? err.message : 'internal error';
      ws.send(JSON.stringify({
        type: 'error',
        requestId,
        message: recoveredFromToolProtocolError
          ? `${message}\n\n已重置本地 TUI 会话，下一条消息会从新的后端会话继续。`
          : message,
      }));
    }
  }
}

async function handleHistoryRequest(deps: LocalServerDeps) {
  const ctx = await loadAgentContext(deps.actorId);
  const setup = buildChatSetup(deps, ctx);
  const snapshot = await chatGraphService.getState(setup);
  return readHistoryMessages(readSnapshotMessages(snapshot));
}

function replaceLocalCapability(
  deps: LocalServerDeps,
  name: string,
  record: CapabilityAvailabilityRecord | null,
) {
  const localCapabilities = deps.localCapabilities;
  if (!localCapabilities) return;

  const index = localCapabilities.findIndex((item) => item.name === name);
  if (record?.availability.available) {
    if (index >= 0) {
      localCapabilities[index] = record.capability;
    } else {
      localCapabilities.push(record.capability);
    }
  } else if (index >= 0) {
    localCapabilities.splice(index, 1);
  }
}

function replaceLocalToolkit(
  deps: LocalServerDeps,
  name: string,
  record: ToolkitAvailabilityRecord | null,
) {
  const localToolkits = deps.localToolkits;
  if (!localToolkits) return;

  const index = localToolkits.findIndex((item) => item.name === name);
  if (record?.availability.available) {
    if (index >= 0) {
      localToolkits[index] = record.toolkit;
    } else {
      localToolkits.push(record.toolkit);
    }
  } else if (index >= 0) {
    localToolkits.splice(index, 1);
  }
}

function replaceUserCapability(
  deps: LocalServerDeps,
  name: string,
  record: CapabilityAvailabilityRecord | null,
) {
  const userCapabilities = deps.userCapabilities;
  if (!userCapabilities) return;

  const index = userCapabilities.findIndex((item) =>
    item.meta.id === name || item.capability.name === name,
  );
  if (record?.availability.available) {
    const definition = deps.userCapabilityDefinitions?.find((item) =>
      item.meta.id === name || item.capability.name === name,
    );
    if (!definition) return;
    if (index >= 0) {
      userCapabilities[index] = definition;
    } else {
      userCapabilities.push(definition);
    }
  } else if (index >= 0) {
    userCapabilities.splice(index, 1);
  }
}

async function refreshRuntimeCapability(deps: LocalServerDeps, name: string) {
  const localRecord = await refreshCapability(deps.localCapabilityDefinitions ?? [], name);
  const localToolkitRecord = await refreshToolkit(deps.localToolkitDefinitions ?? [], name);
  if (localRecord) {
    replaceLocalCapability(deps, name, localRecord);
  }
  if (localToolkitRecord) {
    replaceLocalToolkit(deps, name, localToolkitRecord);
  }
  if (localRecord || localToolkitRecord) {
    return;
  }

  const userDefinition = deps.userCapabilityDefinitions?.find((item) =>
    item.meta.id === name || item.capability.name === name,
  );
  if (!userDefinition) return;

  const userRecord = await refreshCapability(
    deps.userCapabilityDefinitions?.map((item) => item.capability) ?? [],
    userDefinition.capability.name,
  );
  replaceUserCapability(deps, name, userRecord);
}

function readBrowserHealthFields() {
  const availability = getCachedCapabilityAvailability('browser');
  if (!availability) return {};

  const mode = availability.metadata?.mode;
  return {
    browser_mode: typeof mode === 'string'
      ? mode
      : availability.available
        ? 'available'
        : 'none',
    browser_detail: availability.detail ?? availability.reason,
  };
}

export function startLocalServer(port: number, deps: LocalServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Health check endpoint (used by TUI to verify server is running)
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;
      if (pathname === '/health') {
        const writeHealth = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'ok',
            actor_id: deps.actorId,
            actor_name: deps.actorName,
            ...deps.getStats(),
            ...readBrowserHealthFields(),
            ...readActiveToolHealthFields(),
          }));
        };

        const refreshCapabilityName = url.searchParams.get('refresh_capability')
          ?? (url.searchParams.get('refresh_browser') === '1' ? 'browser' : null);
        if (refreshCapabilityName) {
          refreshRuntimeCapability(deps, refreshCapabilityName).then(() => {
            writeHealth();
          }).catch(() => {
            replaceLocalCapability(deps, refreshCapabilityName, null);
            replaceUserCapability(deps, refreshCapabilityName, null);
            writeHealth();
          });
          return;
        }

        writeHealth();
        return;
      }
      if (pathname === '/history') {
        handleHistoryRequest(deps).then((messages) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages }));
        }).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: err instanceof Error ? err.message : 'history load failed',
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      console.log('[local-server] TUI client connected');

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (msg.type === 'chat_request') {
            handleChatRequest(ws, msg as unknown as ChatRequestMessage, deps).catch((err) => {
              console.error('[local-server] handleChatRequest error:', err instanceof Error ? err.message : err);
            });
          } else if (msg.type === 'studio_request') {
            handleStudioRequest(ws, msg as unknown as StudioRequestMessage, deps).catch((err) => {
              console.error('[local-server] handleStudioRequest error:', err instanceof Error ? err.message : err);
            });
          } else if (msg.type === 'interrupt_request') {
            const inflight = inflightRequests.get(ws);
            const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
            if (inflight && (!requestId || inflight.requestId === requestId)) {
              interruptInflightRequest(ws, inflight);
              console.log(`[local-server] interrupt requestId=${inflight.requestId}`);
            }
          } else if (msg.type === 'new_session') {
            resetChatSession(deps.actorId).then(() => {
              console.log(`[local-server] new session created for pet ${deps.actorId}`);
            }).catch((err) => {
              console.error('[local-server] new_session error:', err instanceof Error ? err.message : err);
            });
          } else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        const inflight = inflightRequests.get(ws);
        if (inflight) {
          clearInflightTimer(inflight);
          inflight.controller.abort();
          inflightRequests.delete(ws);
        }
        const slot = studioPendingReviews.get(ws);
        if (slot) {
          rejectReview(slot, new Error('ws disconnected'));
          studioPendingReviews.delete(ws);
        }
        console.log('[local-server] TUI client disconnected');
      });

      ws.on('error', (err) => {
        console.warn('[local-server] WS error:', err.message);
      });
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[local-server] listening on ws://127.0.0.1:${port}`);
      resolve();
    });

    server.on('error', reject);
  });
}
