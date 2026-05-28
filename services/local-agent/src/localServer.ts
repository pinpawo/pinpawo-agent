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
import { loadAgentContext } from './contextLoader';
import { FileSaver } from './fileSaver';
import { buildLocalChatAgentInput } from './agentChannel';
import { LocalAgentGraphService } from './agentGraphService';
import { authorizeShellPattern, clearSessionAuthorizations } from './sessionAuthorizations';
import { buildTuiChatThreadId } from './chatInterface';
import { readShellReviewCommand } from './chatInterrupts';
import {
  parseLocalAgentClientMessage,
  sendLocalAgentMessage,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import { readFirstHumanReviewDecision, type HumanReviewDecision } from '@pinpawo/pet-agent';
import { recordAgentRunActivity, recordToolActivity } from './toolActivityState';
import {
  buildToolOperationEvent,
  buildToolLogMessage,
  readFinalMessageText,
  type StreamToolsPayload,
} from './agentStreamEvents';
import { runChatSession } from './chatSessionAdapter';
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
import { handleLocalHttpRequest } from './localHttpHandlers';
import type { AgentStats, LocalServerDeps } from './localServerTypes';

export type { AgentStats, LocalServerDeps };

const chatCheckpointer = new FileSaver(
  resolve(homedir(), '.pinpawo', 'checkpoints-tui.json'),
);
const sessionStatePath = resolve(homedir(), '.pinpawo', 'tui-sessions.json');

const chatGraphService = new LocalAgentGraphService();

/**
 * Per-ws HITL 答复槽。Studio 模式下,pet 触发 humanReviewer 时,humanReviewer 把
 * promise resolver 寄存在这里;human_review_response handler 调 resolveReview()
 * 喂答复。chat 无 Studio 活跃时此 map 为空。
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
 * 从 human_review_response / legacy chat_request 的 message + resume 字段解码出 HumanReviewDecision。
 * 用于 Studio HITL 答复路由:
 * - msg.resume 显式提供 → 解析
 * - "/allow" 前缀 → approve
 * - 非空 message → respond
 * - 否则 → reject
 */
function decodeStudioDecision(msg: Pick<ChatRequestMessage | HumanReviewResponseMessage, 'message' | 'resume'>): HumanReviewDecision | null {
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

function routeStudioHumanReviewResponse(ws: WebSocket, msg: HumanReviewResponseMessage | ChatRequestMessage) {
  const studioSlot = studioPendingReviews.get(ws);
  if (!studioSlot?.current) {
    return false;
  }
  const decision = decodeStudioDecision(msg);
  if (!decision) {
    return false;
  }
  console.log(
    `[local-server] route ${msg.type} as studio HITL answer (reviewId=${studioSlot.current.reviewId}, decision=${decision.type})`,
  );
  resolveReview(studioSlot, decision);
  return true;
}
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
  sendLocalAgentMessage(ws, {
    type: 'interrupted',
    requestId: inflight.requestId,
    message: 'interrupted',
  });
}

function interruptInflightRequest(ws: WebSocket, inflight: InflightRequest) {
  sendLocalAgentMessage(ws, {
    type: 'interrupting',
    requestId: inflight.requestId,
    message: 'interrupting',
  });
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

function maybeTrimForLog(value: string | undefined, max = 300) {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
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
  const event = buildToolOperationEvent(requestId, payload);
  const message = buildToolLogMessage(requestId, payload);

  if (message.phase === 'error' && isHumanReviewInterruptError(payload.error)) {
    const interruptedEvent = {
      ...event,
      phase: 'interrupted' as const,
      raw: {
        input: event.raw?.input,
      },
    };
    recordToolActivity(payload.name, 'interrupt', requestId);
    console.log(`[local-server] tool_interrupt requestId=${requestId} tool=${payload.name}`);
    sendLocalAgentMessage(ws, { type: 'event', requestId, event: interruptedEvent });
    sendLocalAgentMessage(ws, { ...message, phase: 'interrupt', output: undefined, error: undefined });
    return;
  }

  recordToolActivity(payload.name, message.phase, requestId);

  console.log(
    `[local-server] tool_${message.phase} requestId=${requestId} tool=${payload.name}`
      + (message.input ? ` input=${maybeTrimForLog(message.input, 200)}` : '')
      + (message.error ? ` error=${maybeTrimForLog(message.error)}` : ''),
  );

  sendLocalAgentMessage(ws, { type: 'event', requestId, event });
  sendLocalAgentMessage(ws, message);
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
    if (!envelope || typeof envelope !== 'object') return;
    sendLocalAgentMessage(ws, envelope as Parameters<typeof sendLocalAgentMessage>[1]);
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

  // Legacy compatibility: old TUI builds answered Studio HITL with chat_request.
  if (routeStudioHumanReviewResponse(ws, msg)) {
    return;
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
    const result = await runChatSession({
      request: msg,
      setup,
      graphService: chatGraphService,
      isCurrent,
      finishInterrupted,
      emit: (event) => {
        sendLocalAgentMessage(ws, event);
      },
      emitToolLog: (event) => {
        emitToolLog(ws, requestId, event);
      },
      onPendingInterrupt: (pendingInterrupt) => {
        const pendingShellCommand = readShellReviewCommand(pendingInterrupt);
        if (!pendingShellCommand || !message.trim().startsWith('/allow')) {
          return;
        }
        const requestedPattern = message.trim().slice('/allow'.length).trim();
        const authorizedPattern = authorizeShellPattern(
          threadId,
          requestedPattern || pendingShellCommand,
        );
        if (authorizedPattern) {
          sendLocalAgentMessage(ws, {
            type: 'system_notice',
            requestId,
            message: `已授权本次会话中的 shell 模式：${authorizedPattern}`,
          });
        }
      },
    });
    if (result.status === 'waiting_human') {
      console.log(`[local-server] human_interrupt requestId=${requestId}`);
      clearInflightRequest(ws, inflight);
      return;
    }
    if (result.status === 'interrupted') {
      return;
    }
    clearInflightRequest(ws, inflight);

    console.log(`[local-server] chat_response sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
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
      sendLocalAgentMessage(ws, {
        type: 'error',
        requestId,
        message: recoveredFromToolProtocolError
          ? `${message}\n\n已重置本地 TUI 会话，下一条消息会从新的后端会话继续。`
          : message,
      });
    }
  }
}

async function handleHumanReviewResponse(ws: WebSocket, msg: HumanReviewResponseMessage, deps: LocalServerDeps) {
  if (routeStudioHumanReviewResponse(ws, msg)) {
    return;
  }
  await handleChatRequest(ws, {
    type: 'chat_request',
    requestId: msg.requestId,
    message: msg.message,
    ...(msg.resume !== undefined ? { resume: msg.resume } : {}),
  }, deps);
}

async function handleHistoryRequest(deps: LocalServerDeps) {
  const ctx = await loadAgentContext(deps.actorId);
  const setup = buildChatSetup(deps, ctx);
  const snapshot = await chatGraphService.getState(setup);
  return readHistoryMessages(readSnapshotMessages(snapshot));
}

export function startLocalServer(port: number, deps: LocalServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const handled = handleLocalHttpRequest(req, res, deps, {
        loadHistory: () => handleHistoryRequest(deps),
      });
      if (handled) {
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
          const msg = parseLocalAgentClientMessage(data);
          if (!msg) return;
          if (msg.type === 'chat_request') {
            handleChatRequest(ws, msg, deps).catch((err) => {
              console.error('[local-server] handleChatRequest error:', err instanceof Error ? err.message : err);
            });
          } else if (msg.type === 'studio_request') {
            handleStudioRequest(ws, msg, deps).catch((err) => {
              console.error('[local-server] handleStudioRequest error:', err instanceof Error ? err.message : err);
            });
          } else if (msg.type === 'human_review_response') {
            handleHumanReviewResponse(ws, msg, deps).catch((err) => {
              console.error('[local-server] handleHumanReviewResponse error:', err instanceof Error ? err.message : err);
            });
          } else if (msg.type === 'interrupt_request') {
            const inflight = inflightRequests.get(ws);
            const requestId = msg.requestId;
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
            sendLocalAgentMessage(ws, { type: 'pong' });
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
