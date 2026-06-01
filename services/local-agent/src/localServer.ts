/**
 * Local WebSocket server for TUI ↔ run process communication.
 *
 * Runs inside the `run` process. TUI connects via ws://127.0.0.1:<port>.
 * Protocol matches the App WS relay format so both paths share the same
 * message types.
 */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { loadAgentContext } from './contextLoader';
import { FileSaver } from './fileSaver';
import { buildLocalChatAgentInput } from './agentChannel';
import { LocalAgentGraphService } from './agentGraphService';
import { authorizeShellPattern, clearSessionAuthorizations } from './sessionAuthorizations';
import { readShellReviewCommand } from './chatInterrupts';
import {
  parseLocalAgentClientMessage,
  sendLocalAgentEvent,
  sendLocalAgentMessage,
  type ChatRequestMessage,
  type HumanReviewResponseMessage,
  type StudioRequestMessage,
} from './localAgentProtocol';
import { readFirstHumanReviewDecision, type HumanReviewDecision } from '@pinpawo/pet-agent';
import { recordAgentRunActivity, recordToolActivity } from './toolActivityState';
import {
  buildToolOperationEvent,
  readFinalMessageText,
  type StreamToolsPayload,
} from './agentStreamEvents';
import type { LocalAgentOperationPhase } from './events/localAgentEvent';
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
import {
  createTuiSession,
  ensureActiveTuiSession,
  listTuiSessions,
  loadTuiSessionState,
  resumeTuiSession,
  saveTuiSessionState,
  updateTuiSessionSummary,
  type TuiSessionRecord,
} from './tuiSessionRegistry';

export type { AgentStats, LocalServerDeps };

const chatCheckpointer = new FileSaver(
  resolve(homedir(), '.pinpawo', 'checkpoints-tui.json'),
);

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
 * 从 human_review_response 的 message + resume 字段解码出 HumanReviewDecision。
 * 用于 Studio HITL 答复路由:
 * - msg.resume 显式提供 → 解析
 * - "/allow" 前缀 → approve
 * - 非空 message → respond
 * - 否则 → reject
 */
function decodeStudioDecision(msg: Pick<HumanReviewResponseMessage, 'message' | 'resume'>): HumanReviewDecision | null {
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

function routeStudioHumanReviewResponse(ws: WebSocket, msg: HumanReviewResponseMessage) {
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

const tuiSessionState = loadTuiSessionState();

function saveTuiSessions() {
  saveTuiSessionState(tuiSessionState);
}

function getActiveTuiSession(petId: string) {
  const session = ensureActiveTuiSession(tuiSessionState, petId);
  saveTuiSessions();
  return session;
}

function getChatThreadId(petId: string) {
  return getActiveTuiSession(petId).threadId;
}

function createNewChatSession(petId: string) {
  const previous = getActiveTuiSession(petId);
  const next = createTuiSession(tuiSessionState, petId);
  clearSessionAuthorizations(previous.threadId);
  saveTuiSessions();
  return next;
}

async function resetChatSession(petId: string, options: { deletePrevious?: boolean } = {}) {
  const previous = getActiveTuiSession(petId);
  const next = createTuiSession(tuiSessionState, petId);
  clearSessionAuthorizations(previous.threadId);
  if (options.deletePrevious) {
    await chatCheckpointer.deleteThread(previous.threadId);
    delete tuiSessionState.sessions[previous.id];
  }
  saveTuiSessions();
  return next;
}

function buildChatSetup(
  deps: LocalServerDeps,
  ctx: Awaited<ReturnType<typeof loadAgentContext>>,
  threadId = getChatThreadId(deps.actorId),
) {
  return buildLocalChatAgentInput({
    context: ctx,
    userMessage: '',
    llmConfig: deps.llmConfig,
    tools: deps.pluginTools,
    toolkits: deps.localToolkits,
    extraCapabilities: deps.localCapabilities,
    threadId,
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

function summarizeHistoryMessages(
  messages: Array<{ role: string; text: string }>,
  updatedAt = new Date().toISOString(),
) {
  const titleSource = messages.find((message) => message.role === 'user' && message.text.trim())
    ?? messages.find((message) => message.text.trim());
  const title = titleSource
    ? titleSource.text.replace(/\s+/g, ' ').trim().slice(0, 60)
    : '空会话';
  return {
    title,
    messageCount: messages.length,
    updatedAt,
  };
}

async function readSessionHistoryMessages(
  deps: LocalServerDeps,
  session: TuiSessionRecord,
) {
  const ctx = await loadAgentContext(deps.actorId);
  const setup = buildChatSetup(deps, ctx, session.threadId);
  const snapshot = await chatGraphService.getState(setup);
  return readHistoryMessages(readSnapshotMessages(snapshot));
}

function updateSessionSummaryFromHistory(
  session: TuiSessionRecord,
  messages: Array<{ role: string; text: string }>,
) {
  updateTuiSessionSummary(tuiSessionState, session.id, summarizeHistoryMessages(messages));
  saveTuiSessions();
}

async function refreshActiveSessionSummary(deps: LocalServerDeps) {
  try {
    const session = getActiveTuiSession(deps.actorId);
    const messages = await readSessionHistoryMessages(deps, session);
    updateSessionSummaryFromHistory(session, messages);
  } catch (err) {
    console.warn('[local-server] failed to refresh TUI session summary:', err instanceof Error ? err.message : err);
  }
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

function stringifyLogValue(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
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

function toToolActivityPhase(phase: LocalAgentOperationPhase) {
  if (phase === 'started') return 'start';
  if (phase === 'completed') return 'end';
  if (phase === 'failed') return 'error';
  if (phase === 'interrupted') return 'interrupt';
  return 'event';
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

function sendToolOperationEvent(ws: WebSocket, requestId: string, payload: StreamToolsPayload) {
  const event = buildToolOperationEvent(requestId, payload);

  if (event.phase === 'failed' && isHumanReviewInterruptError(payload.error)) {
    const interruptedEvent = {
      ...event,
      phase: 'interrupted' as const,
      raw: {
        input: event.raw?.input,
      },
    };
    recordToolActivity(payload.name, 'interrupt', requestId);
    console.log(`[local-server] tool_interrupt requestId=${requestId} tool=${payload.name}`);
    sendLocalAgentEvent(ws, interruptedEvent);
    return;
  }

  const phase = toToolActivityPhase(event.phase);
  const input = event.raw?.input !== undefined ? stringifyLogValue(event.raw.input) : undefined;
  const error = event.raw?.error !== undefined ? stringifyLogValue(event.raw.error) : undefined;
  recordToolActivity(payload.name, phase, requestId);

  console.log(
    `[local-server] tool_${phase} requestId=${requestId} tool=${payload.name}`
      + (input ? ` input=${maybeTrimForLog(input, 200)}` : '')
      + (error ? ` error=${maybeTrimForLog(error)}` : ''),
  );

  sendLocalAgentEvent(ws, event);
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
        sendLocalAgentEvent(ws, {
          type: 'studio.progress',
          requestId,
          event,
        });
      },
      onToolEvent: (event) => {
        sendToolOperationEvent(ws, requestId, event as StreamToolsPayload);
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
      emitEvent: (event) => {
        sendLocalAgentEvent(ws, event);
      },
      emitToolEvent: (event) => {
        sendToolOperationEvent(ws, requestId, event);
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
          sendLocalAgentEvent(ws, {
            type: 'system.notice',
            requestId,
            message: `已授权本次会话中的 shell 模式：${authorizedPattern}`,
          });
        }
      },
    });
    if (result.status === 'waiting_human') {
      await refreshActiveSessionSummary(deps);
      console.log(`[local-server] human_review.requested requestId=${requestId}`);
      clearInflightRequest(ws, inflight);
      return;
    }
    if (result.status === 'interrupted') {
      return;
    }
    clearInflightRequest(ws, inflight);
    await refreshActiveSessionSummary(deps);

    console.log(`[local-server] message.completed sent requestId=${requestId} reply="${result.reply.slice(0, 100)}"`);
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
        await resetChatSession(deps.actorId, { deletePrevious: true });
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
      sendLocalAgentEvent(ws, {
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
  const session = getActiveTuiSession(deps.actorId);
  const messages = await readSessionHistoryMessages(deps, session);
  updateTuiSessionSummary(tuiSessionState, session.id, summarizeHistoryMessages(messages, session.updatedAt));
  saveTuiSessions();
  return messages;
}

async function handleSessionsRequest(deps: LocalServerDeps) {
  getActiveTuiSession(deps.actorId);
  const sessions = listTuiSessions(tuiSessionState, deps.actorId);
  const enriched = await Promise.all(sessions.map(async (session) => {
    const messages = await readSessionHistoryMessages(deps, session);
    const summary = summarizeHistoryMessages(messages, session.updatedAt);
    const updated = updateTuiSessionSummary(tuiSessionState, session.id, summary) ?? session;
    return {
      ...updated,
      active: session.active,
      messageCount: summary.messageCount,
      title: summary.title,
      updatedAt: summary.updatedAt,
    };
  }));
  saveTuiSessions();
  return enriched.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt.localeCompare(a.updatedAt));
}

async function handleResumeSessionRequest(deps: LocalServerDeps, sessionId: string) {
  const candidate = tuiSessionState.sessions[sessionId];
  if (!candidate || candidate.petId !== deps.actorId) {
    throw new Error('session not found');
  }
  const messages = await readSessionHistoryMessages(deps, candidate);
  const session = resumeTuiSession(tuiSessionState, deps.actorId, sessionId);
  if (!session) {
    throw new Error('session not found');
  }
  saveTuiSessions();
  updateTuiSessionSummary(tuiSessionState, session.id, summarizeHistoryMessages(messages, session.updatedAt));
  saveTuiSessions();
  return {
    session: {
      ...(tuiSessionState.sessions[session.id] ?? session),
      active: true,
    },
    messages,
  };
}

export function startLocalServer(port: number, deps: LocalServerDeps): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const handled = handleLocalHttpRequest(req, res, deps, {
        loadHistory: () => handleHistoryRequest(deps),
        listSessions: () => handleSessionsRequest(deps),
        resumeSession: (sessionId) => handleResumeSessionRequest(deps, sessionId),
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
            Promise.resolve(createNewChatSession(deps.actorId)).then(() => {
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
