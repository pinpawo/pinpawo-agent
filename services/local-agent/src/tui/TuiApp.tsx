import { randomUUID } from 'node:crypto';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import WebSocket from 'ws';
import { config } from '../config';
import { loadAgentContext } from '../contextLoader';
import { parseLocalAgentServerMessage, sendLocalAgentMessage } from '../localAgentProtocol';
import { InterruptSelector } from './components/InterruptSelector';
import { MessageBlock } from './components/MessageBlock';
import { SmartTextInput } from './components/SmartTextInput';
import {
  buildActiveToolLines,
  buildBusyStatusLine,
  formatNow,
} from './render/terminalText';
import { createInitialTuiState, createSession } from './state/tuiState';
import {
  selectFocusedActiveRun,
  selectFocusedActiveTools,
  selectFocusedBusy,
  selectFocusedHistory,
  selectFocusedPendingInterrupt,
  selectFocusedPendingUi,
  selectFocusedSession,
  selectReady,
  tuiStateReducer,
} from './state/tuiStateReducer';
import type { HistoryCellModel, TuiState } from './state/tuiState';
import type { InterruptOption, MessageRole } from './types';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];
const LOCAL_SERVER_CONNECT_RETRIES = 5;
const LOCAL_SERVER_CONNECT_RETRY_DELAY_MS = 2000;
const LOCAL_SERVER_HEALTH_TIMEOUT_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function buildPetSummary(context: Awaited<ReturnType<typeof loadAgentContext>>) {
  const pet = context.pet;
  const pieces = [pet.species || '未知物种', pet.stage || '未知阶段'];
  if (typeof pet.growth_value === 'number') {
    pieces.push(`成长值 ${pet.growth_value}`);
  }
  return pieces.join(' · ');
}

// ---------------------------------------------------------------------------
// Main TUI application
// ---------------------------------------------------------------------------

export function TuiApp(props: { actorId: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const defaultSessionId = useMemo(() => `chat:${props.actorId}`, [props.actorId]);
  const [tuiState, dispatch] = useReducer(
    tuiStateReducer,
    defaultSessionId,
    (sessionId) => createInitialTuiState(createSession({ id: sessionId })),
  );
  const [animationFrame, setAnimationFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));
  const [studioMode, setStudioMode] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<TuiState>(tuiState);
  const lastInterruptAtRef = useRef(0);
  const interruptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Studio 模式持续期间共用一个 conversationId,这样 wiki 跨 turn 累积、
  // pet runtime 的 thread namespace 也保持一致
  const studioConversationIdRef = useRef<string | null>(null);
  const studioModeRef = useRef(false);
  const focusedSession = selectFocusedSession(tuiState);
  const messages = selectFocusedHistory(tuiState);
  const inputValue = tuiState.input.value;
  const ready = selectReady(tuiState);
  const busy = selectFocusedBusy(tuiState);
  const pendingUi = selectFocusedPendingUi(tuiState);
  const activeTools = selectFocusedActiveTools(tuiState);
  const pendingInterrupt = selectFocusedPendingInterrupt(tuiState);
  const petName = focusedSession?.actor.label ?? '宠物';
  const petSummary = focusedSession?.actor.summary ?? 'pet 未加载';
  const status = tuiState.connection.message;

  useEffect(() => {
    stateRef.current = tuiState;
  }, [tuiState]);

  const appendMessage = (role: MessageRole, text: string) => {
    dispatch({
      type: 'history.append',
      cell: {
        id: randomUUID(),
        kind: role,
        timestamp: formatNow(),
        text,
      },
    });
  };

  const setInputValue = (value: string) => {
    dispatch({ type: 'input.set', value });
  };

  const clearInterruptTimeout = () => {
    if (interruptTimeoutRef.current) {
      clearTimeout(interruptTimeoutRef.current);
      interruptTimeoutRef.current = null;
    }
  };

  const makeHistoryMeta = () => ({
    id: randomUUID(),
    timestamp: formatNow(),
  });

  const getCurrentActiveRun = () => selectFocusedActiveRun(stateRef.current);

  const getCurrentBusy = () => selectFocusedBusy(stateRef.current);

  const getCurrentPendingInterrupt = () => selectFocusedPendingInterrupt(stateRef.current);

  /** 发起一次 Studio turn(复用本会话的 conversationId) */
  const fireStudioRequest = (ws: WebSocket, userRequest: string) => {
    const requestId = randomUUID();
    const nowMs = Date.now();
    setNow(nowMs);
    dispatch({
      type: 'run.start',
      requestId,
      kind: 'studio',
      userText: `[studio] ${userRequest}`,
      now: nowMs,
      userCell: makeHistoryMeta(),
      statusMessage: 'Studio 编排中',
    });
    sendLocalAgentMessage(ws, {
      type: 'studio_request',
      requestId,
      userRequest,
      ...(studioConversationIdRef.current
        ? { conversationId: studioConversationIdRef.current }
        : {}),
    });
  };

  const submitInterruptDecision = (option: InterruptOption) => {
    const decision = option.message.trim();
    if (!decision) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendMessage('system', '未连接，无法提交确认。');
      return;
    }
    const currentInterrupt = getCurrentPendingInterrupt();
    const requestId = currentInterrupt?.requestId ?? randomUUID();
    const nowMs = Date.now();
    setNow(nowMs);
    dispatch({
      type: 'review.response.start',
      requestId,
      message: decision,
      now: nowMs,
      userCell: makeHistoryMeta(),
      statusMessage: '提交确认',
    });
    sendLocalAgentMessage(ws, {
      type: 'human_review_response',
      requestId,
      message: decision,
      ...(option.resume !== undefined ? { resume: option.resume } : {}),
    });
  };

  const interruptCurrentInput = () => {
    const ws = wsRef.current;
    const activeRun = getCurrentActiveRun();
    if (!getCurrentBusy() || !ws || ws.readyState !== WebSocket.OPEN || !activeRun) {
      return;
    }
    sendLocalAgentMessage(ws, {
      type: 'interrupt_request',
      requestId: activeRun.requestId,
    });
    lastInterruptAtRef.current = Date.now();
    dispatch({
      type: 'run.interrupting',
      requestId: activeRun.requestId,
      statusMessage: '正在打断',
    });
    clearInterruptTimeout();
    const interruptRequestId = activeRun.requestId;
    interruptTimeoutRef.current = setTimeout(() => {
      const currentRun = selectFocusedActiveRun(stateRef.current);
      if (!selectFocusedBusy(stateRef.current) || currentRun?.requestId !== interruptRequestId) {
        return;
      }
      dispatch({
        type: 'run.finish',
        requestId: interruptRequestId,
        statusMessage: '已请求打断',
        history: [{
          ...makeHistoryMeta(),
          kind: 'system',
          text: '打断请求已发送，本地先释放输入；迟到的旧响应会被忽略。',
        }],
      });
    }, 1800);
  };

  const submitCurrentInput = () => {
    const text = inputValue.trim();
    if (!text) return;

    if (text === '/quit' || text === '/exit') {
      exit();
      return;
    }

    if (text === '/help' || text === '/') {
      appendMessage(
        'system',
        '/new 新会话 · /studio [任务] 进入 Studio 模式 · /chat 退出 Studio · /help · /quit',
      );
      setInputValue('');
      return;
    }

    if (text === '/chat') {
      if (studioModeRef.current) {
        studioModeRef.current = false;
        studioConversationIdRef.current = null;
        setStudioMode(false);
        dispatch({ type: 'session.set_kind', kind: 'chat' });
        appendMessage('system', '已退出 Studio 模式,回到单 pet chat');
      } else {
        appendMessage('system', '当前不在 Studio 模式');
      }
      setInputValue('');
      return;
    }

    if (text === '/studio' || text.startsWith('/studio ')) {
      const userRequest = text === '/studio' ? '' : text.slice('/studio '.length).trim();
      if (!userRequest && studioModeRef.current) {
        // toggle 退出
        studioModeRef.current = false;
        studioConversationIdRef.current = null;
        setStudioMode(false);
        dispatch({ type: 'session.set_kind', kind: 'chat' });
        appendMessage('system', '已退出 Studio 模式');
        setInputValue('');
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendMessage('system', '未连接,无法发送');
        return;
      }
      if (getCurrentBusy()) {
        appendMessage('system', '当前任务仍在进行中,按 Ctrl+C 或 Esc 打断');
        return;
      }
      // 进入 Studio 模式(若不在)
      if (!studioModeRef.current) {
        studioModeRef.current = true;
        studioConversationIdRef.current = randomUUID();
        setStudioMode(true);
        dispatch({ type: 'session.set_kind', kind: 'studio' });
        appendMessage(
          'system',
          `已进入 Studio 模式 (conversation=${studioConversationIdRef.current.slice(0, 8)})。后续输入都属于此会话,输入 /chat 或 /studio 退出。`,
        );
      }
      if (!userRequest) {
        // 仅 toggle 进入,没首棒输入
        setInputValue('');
        return;
      }
      fireStudioRequest(ws, userRequest);
      return;
    }

    if (text === '/new') {
      setInputValue('');
      clearInterruptTimeout();
      dispatch({
        type: 'session.clear',
        statusMessage: '已创建新会话',
      });
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendLocalAgentMessage(ws, { type: 'new_session' });
      }
      return;
    }

    if (text.startsWith('/')) {
      if (text.startsWith('/allow')) {
        // /allow always submits as interrupt decision (server checks pending interrupt)
        submitInterruptDecision({ label: text, message: text });
        return;
      }
      appendMessage('system', `未知命令：${text}`);
      setInputValue('');
      return;
    }

    // Free-text input while interrupt selector was dismissed via Esc:
    // server still has the pending interrupt, so this text becomes the resume value
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendMessage('system', '未连接，无法发送');
      return;
    }

    if (getCurrentBusy()) {
      appendMessage('system', '当前任务仍在进行中，按 Ctrl+C 或 Esc 打断');
      return;
    }

    // Studio 模式下:普通文本走 studio_request(沿用同一 conversationId)
    if (studioModeRef.current) {
      fireStudioRequest(ws, text);
      return;
    }

    const requestId = randomUUID();
    const nowMs = Date.now();
    setNow(nowMs);
    dispatch({
      type: 'run.start',
      requestId,
      kind: 'chat',
      userText: text,
      now: nowMs,
      userCell: makeHistoryMeta(),
      statusMessage: '等待回复',
    });

    sendLocalAgentMessage(ws, {
      type: 'chat_request',
      requestId,
      message: text,
    });
  };

  const handleWsMessage = (data: Buffer | string) => {
    try {
      const msg = parseLocalAgentServerMessage(data);
      if (!msg || msg.type === 'pong') {
        return;
      }

      if (msg.type === 'event') {
        dispatch({
          type: 'event.received',
          event: msg.event,
          now: Date.now(),
          historyCell: makeHistoryMeta(),
        });
        return;
      }

      if (msg.type === 'interrupting') {
        dispatch({
          type: 'server.interrupting',
          requestId: msg.requestId,
          statusMessage: '正在打断',
        });
        return;
      }

      if (msg.type === 'interrupted') {
        clearInterruptTimeout();
        dispatch({
          type: 'server.interrupted',
          requestId: msg.requestId,
          historyCell: makeHistoryMeta(),
          statusMessage: '已打断',
        });
        return;
      }

      if (msg.type === 'studio_response') {
        clearInterruptTimeout();
        dispatch({
          type: 'server.studio_response',
          requestId: msg.requestId,
          outcome: msg.outcome,
          reply: msg.reply,
          reason: msg.reason,
          historyCell: makeHistoryMeta(),
          stoppedReasonCell: makeHistoryMeta(),
          statusMessage: '就绪',
        });
        return;
      }

      if (msg.type === 'studio_error') {
        clearInterruptTimeout();
        dispatch({
          type: 'server.studio_error',
          requestId: msg.requestId,
          message: msg.message,
          historyCell: makeHistoryMeta(),
          statusMessage: 'Studio 出错,已恢复输入',
        });
        return;
      }

      if (msg.type === 'error') {
        clearInterruptTimeout();
        dispatch({
          type: 'server.error',
          requestId: msg.requestId,
          message: msg.message,
          historyCell: makeHistoryMeta(),
          statusMessage: '出错，已恢复输入',
        });
      }
    } catch {
      // ignore malformed messages
    }
  };

  useEffect(() => {
    if (!busy) {
      setAnimationFrame(0);
      clearInterruptTimeout();
      return;
    }
    const interval = setInterval(() => {
      setAnimationFrame((current) => (current + 1) % SPINNER_FRAMES.length);
      setNow(Date.now());
    }, 120);
    return () => clearInterval(interval);
  }, [busy]);

  useEffect(() => {
    const handleResize = () => {
      setTerminalSize({
        columns: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      });
    };
    handleResize();
    stdout.on?.('resize', handleResize);
    return () => {
      stdout.off?.('resize', handleResize);
    };
  }, [stdout]);

  useEffect(() => {
    let disposed = false;

    const init = async () => {
      dispatch({
        type: 'connection.set',
        status: 'connecting',
        message: '连接本地服务',
      });
      let connected = false;
      for (let attempt = 0; attempt <= LOCAL_SERVER_CONNECT_RETRIES; attempt += 1) {
        if (disposed) return;
        try {
          const healthRes = await fetchWithTimeout(
            `http://127.0.0.1:${config.localServerPort}/health`,
            LOCAL_SERVER_HEALTH_TIMEOUT_MS,
          );
          if (!healthRes.ok) {
            throw new Error(`health check failed: ${healthRes.status}`);
          }
          connected = true;
          break;
        } catch {
          if (disposed) return;
          if (attempt >= LOCAL_SERVER_CONNECT_RETRIES) {
            appendMessage('system', `无法连接本地服务 (port ${config.localServerPort})，请先运行 pinpawo-agent run`);
            dispatch({
              type: 'connection.set',
              status: 'disconnected',
              message: '未连接',
            });
            return;
          }
          const retryIndex = attempt + 1;
          const retryText = `本地服务暂不可用，${LOCAL_SERVER_CONNECT_RETRY_DELAY_MS / 1000}s 后重试 ${retryIndex}/${LOCAL_SERVER_CONNECT_RETRIES}`;
          dispatch({
            type: 'connection.set',
            status: 'connecting',
            message: retryText,
          });
          appendMessage('system', retryText);
          await sleep(LOCAL_SERVER_CONNECT_RETRY_DELAY_MS);
        }
      }

      if (disposed || !connected) return;

      try {
        const historyRes = await fetch(`http://127.0.0.1:${config.localServerPort}/history`);
        if (historyRes.ok) {
          const payload = await historyRes.json() as {
            messages?: Array<{ role?: string; text?: string }>;
          };
          const restored = Array.isArray(payload.messages)
            ? payload.messages.flatMap((item) => {
              if (
                (item.role === 'user' || item.role === 'assistant' || item.role === 'system')
                && typeof item.text === 'string'
                && item.text.trim()
              ) {
                return [{
                  id: randomUUID(),
                  kind: item.role,
                  text: item.text,
                } satisfies HistoryCellModel];
              }
              return [];
            })
            : [];
          if (restored.length > 0) {
            dispatch({
              type: 'session.replace_history',
              history: restored,
            });
          }
        }
      } catch {
        // history restore is best-effort
      }

      const ws = new WebSocket(`ws://127.0.0.1:${config.localServerPort}`);
      wsRef.current = ws;

      ws.on('open', () => {
        if (disposed) {
          ws.close();
          return;
        }
        dispatch({
          type: 'connection.set',
          status: 'ready',
          message: '就绪',
        });
      });

      ws.on('message', handleWsMessage);

      ws.on('close', () => {
        if (disposed) return;
        dispatch({
          type: 'connection.set',
          status: 'disconnected',
          message: '连接断开',
        });
        wsRef.current = null;
      });

      ws.on('error', (err) => {
        if (disposed) return;
        appendMessage('system', `WS error: ${err.message}`);
      });

      try {
        const context = await loadAgentContext(props.actorId);
        if (disposed) return;
        dispatch({
          type: 'session.set_actor',
          actor: {
            label: context.pet.name,
            summary: buildPetSummary(context),
          },
        });
      } catch {
        if (!disposed) {
          appendMessage('system', '无法加载宠物信息，使用默认名称');
        }
      }
    };

    init().catch((err) => {
      if (disposed) return;
      const message = err instanceof Error ? err.message : String(err);
      appendMessage('system', `初始化失败: ${message}`);
      dispatch({
        type: 'connection.set',
        status: 'error',
        message: `初始化失败: ${message}`,
      });
    });

    return () => {
      disposed = true;
      if (wsRef.current) {
        wsRef.current.removeAllListeners();
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [props.actorId]);

  // Global key handler — only handles Ctrl+C and Esc (when not in interrupt selector)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (getCurrentBusy()) {
        const nowMs = Date.now();
        if (nowMs - lastInterruptAtRef.current < 1200) {
          appendMessage('system', '收到第二次 Ctrl+C，立即退出 TUI。');
          exit();
          return;
        }
        interruptCurrentInput();
        appendMessage('system', '已发送打断请求。再次按 Ctrl+C 可直接退出 TUI。');
        return;
      }
      appendMessage('system', '正在退出 TUI。');
      exit();
      return;
    }

    if (!ready) {
      return;
    }

    if (key.escape) {
      // Interrupt selector dismissal is handled inside InterruptSelector itself via onDismiss.
      // Here we only handle Esc for non-interrupt scenarios.
      if (pendingInterrupt) return; // InterruptSelector owns Esc
      if (getCurrentBusy()) {
        interruptCurrentInput();
        return;
      }
      setInputValue('');
    }
  }, { isActive: true });

  const spinnerFrame = SPINNER_FRAMES[animationFrame];
  const contentWidth = Math.max(20, terminalSize.columns - 4);
  const activeToolLines = useMemo(
    () => buildActiveToolLines(activeTools, now, contentWidth),
    [activeTools, now, contentWidth],
  );

  // Input area focus: only when ready, not busy, and no interrupt selector
  const inputFocused = ready && !busy && !pendingInterrupt;

  // Contextual help text
  const helpText = busy
    ? 'Ctrl+C 打断 · 再按一次退出'
    : pendingInterrupt
      ? '' // help is shown inside InterruptSelector
      : '/new 新会话 · /help 帮助 · /quit 退出';

  return (
    <Box flexDirection="column" paddingX={1}>
      {messages.length === 0 ? <Text dimColor>和 {petName} 聊天吧。</Text> : null}
      <Static items={messages}>
        {(entry) => <MessageBlock key={entry.id} entry={entry} petName={petName} width={contentWidth} />}
      </Static>
      {activeToolLines.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {activeToolLines.map((line) => (
            <Text key={line.id} color="blue" dimColor>
              {line.text}
            </Text>
          ))}
        </Box>
      ) : null}
      {pendingInterrupt ? (
        <InterruptSelector
          interrupt={pendingInterrupt}
          width={contentWidth}
          onSelect={submitInterruptDecision}
          onDismiss={() => {
            dispatch({
              type: 'review.dismiss',
              requestId: pendingInterrupt.requestId,
              statusMessage: '已关闭确认面板 · 可自由输入',
            });
            setInputValue('');
          }}
        />
      ) : null}
      {!pendingInterrupt ? (
        <Text dimColor>
          {pendingUi
            ? buildBusyStatusLine(pendingUi, now, spinnerFrame, activeTools)
            : `${status} · ${petSummary}`}
        </Text>
      ) : null}
      <Box
        borderStyle="round"
        borderColor={busy ? 'yellow' : pendingInterrupt ? 'yellow' : 'gray'}
        paddingX={1}
        marginTop={pendingInterrupt ? 0 : 1}
      >
        {busy ? (
          <Text dimColor>{'> 处理中…'}</Text>
        ) : (
          <>
            <Text color="cyan">{'> '}</Text>
            <SmartTextInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={submitCurrentInput}
              placeholder={pendingInterrupt ? '输入自由回复，或按 ↑ 返回选择器' : '输入消息'}
              focus={inputFocused}
            />
          </>
        )}
      </Box>
      {helpText ? <Text dimColor>{helpText}</Text> : null}
    </Box>
  );
}
