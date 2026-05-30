import { randomUUID } from 'node:crypto';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { config } from '../config';
import { Composer } from './components/Composer';
import { buildInterruptSelectOptions, InterruptSelector } from './components/InterruptSelector';
import { MessageBlock } from './components/MessageBlock';
import { formatTuiCommandHelp, parseTuiCommand } from './input/commandRegistry';
import { applyComposerInput, resolveTuiKeyAction } from './input/keymap';
import {
  buildActiveToolLines,
  buildBusyStatusLine,
  formatNow,
} from './render/terminalText';
import { createInitialTuiState, createSession } from './state/tuiState';
import {
  selectFocusedActiveTools,
  selectFocusedBusy,
  selectFocusedHistory,
  selectFocusedPendingInterrupt,
  selectFocusedPendingUi,
  selectFocusedSession,
  selectReady,
  tuiStateReducer,
} from './state/tuiStateReducer';
import { TuiRuntimeController } from './TuiRuntimeController';
import type { TuiState } from './state/tuiState';
import type { MessageRole } from './types';

const SPINNER_FRAMES = ['-', '\\', '|', '/'];

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
  const [composerCursorOffset, setComposerCursorOffset] = useState(0);
  const [approvalIndex, setApprovalIndex] = useState(0);

  const stateRef = useRef<TuiState>(tuiState);
  const lastInterruptAtRef = useRef(0);
  const localServerPort = config.localServerPort;
  // Studio 模式持续期间共用一个 conversationId,这样 wiki 跨 turn 累积、
  // pet runtime 的 thread namespace 也保持一致
  const studioConversationIdRef = useRef<string | null>(null);
  const studioModeRef = useRef(false);
  const runtimeController = useMemo(() => new TuiRuntimeController({
    actorId: props.actorId,
    localServerPort,
    dispatch,
    getState: () => stateRef.current,
    setNow,
  }), [props.actorId, localServerPort, dispatch, setNow]);
  const focusedSession = selectFocusedSession(tuiState);
  const messages = selectFocusedHistory(tuiState);
  const inputValue = tuiState.input.value;
  const ready = selectReady(tuiState);
  const busy = selectFocusedBusy(tuiState);
  const pendingUi = selectFocusedPendingUi(tuiState);
  const activeTools = selectFocusedActiveTools(tuiState);
  const pendingInterrupt = selectFocusedPendingInterrupt(tuiState);
  const approvalOptions = useMemo(
    () => (pendingInterrupt ? buildInterruptSelectOptions(pendingInterrupt) : []),
    [pendingInterrupt],
  );
  const petName = focusedSession?.actor.label ?? '宠物';
  const petSummary = focusedSession?.actor.summary ?? 'pet 未加载';
  const status = tuiState.connection.message;

  useEffect(() => {
    stateRef.current = tuiState;
  }, [tuiState]);

  useEffect(() => {
    setComposerCursorOffset((current) => Math.min(current, inputValue.length));
  }, [inputValue.length]);

  useEffect(() => {
    setApprovalIndex(0);
  }, [pendingInterrupt?.requestId]);

  useEffect(() => {
    setApprovalIndex((current) => Math.min(current, Math.max(0, approvalOptions.length - 1)));
  }, [approvalOptions.length]);

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

  const clearInputValue = () => {
    setInputValue('');
    setComposerCursorOffset(0);
  };

  const submitCurrentInput = () => {
    const parsed = parseTuiCommand(inputValue);
    if (parsed.type === 'empty') return;

    if (parsed.type === 'command') {
      if (parsed.name === 'quit') {
        exit();
        return;
      }

      if (parsed.name === 'help') {
        appendMessage('system', formatTuiCommandHelp());
        clearInputValue();
        return;
      }

      if (parsed.name === 'chat') {
        if (studioModeRef.current) {
          studioModeRef.current = false;
          studioConversationIdRef.current = null;
          setStudioMode(false);
          dispatch({ type: 'session.set_kind', kind: 'chat' });
          appendMessage('system', '已退出 Studio 模式,回到单 pet chat');
        } else {
          appendMessage('system', '当前不在 Studio 模式');
        }
        clearInputValue();
        return;
      }

      if (parsed.name === 'studio') {
        const userRequest = parsed.args;
        if (!userRequest && studioModeRef.current) {
          // toggle 退出
          studioModeRef.current = false;
          studioConversationIdRef.current = null;
          setStudioMode(false);
          dispatch({ type: 'session.set_kind', kind: 'chat' });
          appendMessage('system', '已退出 Studio 模式');
          clearInputValue();
          return;
        }
        if (!runtimeController.isConnected()) {
          appendMessage('system', '未连接,无法发送');
          return;
        }
        if (runtimeController.isBusy()) {
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
          clearInputValue();
          return;
        }
        runtimeController.sendStudioRequest(userRequest, studioConversationIdRef.current);
        return;
      }

      if (parsed.name === 'new') {
        runtimeController.startNewSession();
        return;
      }

      if (parsed.name === 'allow') {
        // /allow always submits as interrupt decision (server checks pending interrupt)
        runtimeController.submitReviewResponse({ label: parsed.raw, message: parsed.raw });
        return;
      }

      return;
    }

    if (parsed.type === 'unknown') {
      appendMessage('system', `未知命令：${parsed.raw}`);
      clearInputValue();
      return;
    }

    const text = parsed.text;
    // Free-text input while interrupt selector was dismissed via Esc:
    // server still has the pending interrupt, so this text becomes the resume value
    // Studio 模式下:普通文本走 studio_request(沿用同一 conversationId)
    if (studioModeRef.current) {
      runtimeController.sendStudioRequest(text, studioConversationIdRef.current);
      return;
    }

    runtimeController.sendChatRequest(text);
  };

  useEffect(() => {
    if (!busy) {
      setAnimationFrame(0);
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
    runtimeController.start();
    return () => runtimeController.dispose();
  }, [runtimeController]);

  useInput((input, key) => {
    const action = resolveTuiKeyAction(input, key, {
      ready,
      busy,
      hasPendingInterrupt: Boolean(pendingInterrupt),
    });

    switch (action.type) {
      case 'global.ctrl_c':
        if (busy) {
          const nowMs = Date.now();
          if (nowMs - lastInterruptAtRef.current < 1200) {
            appendMessage('system', '收到第二次 Ctrl+C，立即退出 TUI。');
            exit();
            return;
          }
          if (runtimeController.requestInterrupt()) {
            lastInterruptAtRef.current = nowMs;
          }
          appendMessage('system', '已发送打断请求。再次按 Ctrl+C 可直接退出 TUI。');
          return;
        }
        appendMessage('system', '正在退出 TUI。');
        exit();
        return;

      case 'global.interrupt':
        runtimeController.requestInterrupt();
        return;

      case 'approval.previous':
        setApprovalIndex((current) => Math.max(0, current - 1));
        return;

      case 'approval.next':
        setApprovalIndex((current) => Math.max(0, Math.min(approvalOptions.length - 1, current + 1)));
        return;

      case 'approval.submit': {
        const option = approvalOptions[approvalIndex] ?? approvalOptions[0];
        if (option) {
          runtimeController.submitReviewResponse(option);
        }
        return;
      }

      case 'approval.dismiss':
        if (pendingInterrupt) {
          runtimeController.dismissReview(pendingInterrupt.requestId);
        }
        return;

      case 'composer.clear':
        clearInputValue();
        return;

      case 'composer.submit':
        submitCurrentInput();
        return;

      case 'composer.edit': {
        const nextComposerState = applyComposerInput(input, key, {
          value: inputValue,
          cursorOffset: composerCursorOffset,
        });
        setComposerCursorOffset(nextComposerState.cursorOffset);
        if (nextComposerState.value !== inputValue) {
          setInputValue(nextComposerState.value);
        }
        return;
      }

      case 'none':
        return;

      default:
        return;
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
          options={approvalOptions}
          selectedIndex={approvalIndex}
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
            <Composer
              value={inputValue}
              cursorOffset={composerCursorOffset}
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
