import { randomUUID } from 'node:crypto';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, render, useApp, useInput, useStdout } from 'ink';
import Markdown from '@inkkit/ink-markdown';
import stringWidth from 'string-width';
import WebSocket from 'ws';
import { config } from '../config';
import { loadAgentContext } from '../contextLoader';
import { ensureActorSelected } from '../actorSelection';

type MessageRole = 'user' | 'assistant' | 'system';

type MessageEntry = {
  id: string;
  role: MessageRole;
  timestamp?: string;
  text: string;
};

type PendingUiState = {
  startedAt: number;
  phase: 'thinking' | 'replying' | 'interrupting';
  charCount: number;
};

type PendingInterrupt = {
  kind: string;
  prompt: string;
  payload: Record<string, unknown>;
  /** Studio 模式下,触发本次 HITL 的 pet id;chat 路径下为 undefined */
  petId?: string;
};

type InterruptOption = {
  label: string;
  message: string;
  resume?: unknown;
};

type ActiveTool = {
  name: string;
  label: string;
  detail: string;
  startedAt: number;
};

const MAX_MESSAGES = 240;
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

function trimItems<T>(items: T[], max: number) {
  return items.length > max ? items.slice(items.length - max) : items;
}

function formatNow() {
  return new Date().toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatElapsed(startedAt: number, now: number) {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function buildBusyPhaseLabel(pending: PendingUiState, now: number) {
  if (pending.phase === 'interrupting') return '正在打断';
  if (pending.phase === 'replying') return '正在回复';
  const elapsedMs = now - pending.startedAt;
  if (elapsedMs < 3000) return '正在思考';
  if (elapsedMs < 10000) return '正在调用能力或工具';
  return '仍在处理中';
}

function buildBusyStatusLine(
  pending: PendingUiState,
  now: number,
  spinnerFrame: string,
  activeTools: ActiveTool[],
) {
  const phase = buildBusyPhaseLabel(pending, now);
  const elapsed = formatElapsed(pending.startedAt, now);
  const detail = pending.charCount > 0 ? ` · ${pending.charCount} 字` : '';
  const tools = activeTools.length > 0 ? ` · ${activeTools.map((tool) => tool.name).join(', ')}` : '';
  return `${spinnerFrame} ${phase} · ${elapsed}${detail}${tools}`;
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
// Interrupt selector
// ---------------------------------------------------------------------------

function buildInterruptSelectOptions(interrupt: PendingInterrupt): InterruptOption[] {
  const actionRequests = Array.isArray(interrupt.payload.actionRequests)
    ? interrupt.payload.actionRequests.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'),
    )
    : [];
  const reviewConfigs = Array.isArray(interrupt.payload.reviewConfigs)
    ? interrupt.payload.reviewConfigs.filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object'),
    )
    : [];
  const firstAction = actionRequests[0];
  const firstConfig = reviewConfigs[0];
  const actionName = firstAction && typeof firstAction.name === 'string'
    ? firstAction.name
    : firstAction && typeof firstAction.action === 'string'
      ? firstAction.action
      : '';
  const args = firstAction?.args && typeof firstAction.args === 'object'
    ? firstAction.args as Record<string, unknown>
    : {};
  const command = typeof args.command === 'string' ? args.command : '';
  const allowedDecisions = Array.isArray(firstConfig?.allowedDecisions)
    ? firstConfig.allowedDecisions.filter((item): item is string => typeof item === 'string')
    : ['approve', 'reject', 'respond'];

  if (actionRequests.length > 0) {
    const options: InterruptOption[] = [];
    if (allowedDecisions.includes('approve')) {
      options.push({
        label: actionName === 'continue_execution_window' ? '继续' : '批准执行',
        message: actionName === 'continue_execution_window' ? '继续' : '批准执行',
        resume: { decisions: [{ type: 'approve' }] },
      });
    }
    if ((actionName === 'shell' || actionName === 'run_shell') && command) {
      options.push({
        label: `本次会话授权：${shorten(command, 40)}`,
        message: '/allow',
      });
    }
    if (allowedDecisions.includes('reject')) {
      options.push({
        label: actionName === 'continue_execution_window' ? '停在这里' : '拒绝',
        message: actionName === 'continue_execution_window' ? '停在这里' : '拒绝',
        resume: { decisions: [{ type: 'reject' }] },
      });
    }
    if (options.length > 0) {
      return options;
    }
  }
  return [
    { label: '批准', message: '批准', resume: { decisions: [{ type: 'approve' }] } },
    { label: '拒绝', message: '拒绝', resume: { decisions: [{ type: 'reject' }] } },
  ];
}

function InterruptSelector(props: {
  interrupt: PendingInterrupt;
  width: number;
  onSelect: (option: InterruptOption) => void;
  onDismiss: () => void;
}) {
  const [index, setIndex] = useState(0);
  const options = useMemo(
    () => buildInterruptSelectOptions(props.interrupt),
    [props.interrupt],
  );

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return; // let parent handle
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (key.return) {
      props.onSelect(options[index]!);
      return;
    }
    if (key.escape) {
      props.onDismiss();
    }
  }, { isActive: true });

  const promptLines = wrapLine(props.interrupt.prompt, props.width - 4);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
      width={props.width}
    >
      <Text color="yellow">
        {props.interrupt.petId ? `[${props.interrupt.petId} 想问你]` : '需要确认'}
      </Text>
      {promptLines.map((line, i) => (
        <Text key={`p-${i}`}>{line}</Text>
      ))}
      <Text>{' '}</Text>
      {options.map((opt, i) => (
        <Text key={`o-${i}`} color={i === index ? 'cyan' : undefined} bold={i === index}>
          {i === index ? '› ' : '  '}{opt.label}
        </Text>
      ))}
      <Text>{' '}</Text>
      <Text dimColor>↑↓ 选择 · Enter 确认 · Esc 自由输入</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Smart text input with terminal shortcuts
// ---------------------------------------------------------------------------

function SmartTextInput(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}) {
  const { value, onChange, onSubmit, placeholder = '', focus = true } = props;
  const [cursorOffset, setCursorOffset] = useState(value.length);

  useEffect(() => {
    setCursorOffset((prev) => Math.min(prev, value.length));
  }, [value]);

  useInput((input, key) => {
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) return;
    if (key.ctrl && input === 'c') return; // let parent handle
    if (key.escape) return; // let parent handle

    if (key.return) {
      onSubmit?.(value);
      return;
    }

    let nextValue = value;
    let nextCursor = cursorOffset;

    if (key.ctrl) {
      switch (input) {
        case 'a':
          nextCursor = 0;
          break;
        case 'e':
          nextCursor = value.length;
          break;
        case 'k':
          nextValue = value.slice(0, cursorOffset);
          break;
        case 'u':
          nextValue = value.slice(cursorOffset);
          nextCursor = 0;
          break;
        case 'w': {
          const before = value.slice(0, cursorOffset);
          const trimmed = before.replace(/\s+$/, '');
          const wordStart = Math.max(0, trimmed.lastIndexOf(' ') + 1);
          nextValue = value.slice(0, wordStart) + value.slice(cursorOffset);
          nextCursor = wordStart;
          break;
        }
        default:
          return;
      }
    } else if (key.leftArrow) {
      nextCursor = Math.max(0, cursorOffset - 1);
    } else if (key.rightArrow) {
      nextCursor = Math.min(value.length, cursorOffset + 1);
    } else if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        nextValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        nextCursor = cursorOffset - 1;
      }
    } else {
      nextValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
      nextCursor = cursorOffset + input.length;
    }

    nextCursor = Math.max(0, Math.min(nextValue.length, nextCursor));
    setCursorOffset(nextCursor);
    if (nextValue !== value) {
      onChange(nextValue);
    }
  }, { isActive: focus });

  // Render: no focus or empty+unfocused → placeholder
  if (!focus) {
    return <Text dimColor>{value || placeholder}</Text>;
  }

  if (!value) {
    if (placeholder) {
      return (
        <Text>
          <Text inverse>{placeholder[0] ?? ' '}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    }
    return <Text inverse>{' '}</Text>;
  }

  const before = value.slice(0, cursorOffset);
  const cursorChar = cursorOffset < value.length ? value[cursorOffset]! : ' ';
  const after = cursorOffset < value.length ? value.slice(cursorOffset + 1) : '';

  return (
    <Text>
      {before}<Text inverse>{cursorChar}</Text>{after}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function safeParseJson(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function shorten(value: string, max = 60) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function formatStudioTurnEvent(event: Record<string, unknown>): string | null {
  const type = typeof event.type === 'string' ? event.type : null;
  if (!type) return null;
  switch (type) {
    case 'turn_started':
      return null; // 起手不刷屏
    case 'plan_set': {
      const plan = event.plan && typeof event.plan === 'object'
        ? event.plan as Record<string, unknown>
        : null;
      const tasks = plan && Array.isArray(plan.tasks) ? plan.tasks : [];
      return `[studio] plan 设定:${tasks.length} 棒`;
    }
    case 'dispatch_started': {
      const petId = typeof event.petId === 'string' ? event.petId : '?';
      const taskIndex = typeof event.taskIndex === 'number' ? event.taskIndex : '?';
      return `[studio] dispatch[#${taskIndex}] → pet:${petId}`;
    }
    case 'task_status_changed': {
      const taskIndex = typeof event.taskIndex === 'number' ? event.taskIndex : '?';
      const status = typeof event.status === 'string' ? event.status : '?';
      return `[studio] task[#${taskIndex}] → ${status}`;
    }
    case 'wiki_updated': {
      const changed = Array.isArray(event.changedPaths) ? event.changedPaths : [];
      return `[studio] wiki 更新 ${changed.length} 项`;
    }
    case 'dispatch_finished': {
      const dispatchId = typeof event.dispatchId === 'string' ? event.dispatchId : '?';
      const status = typeof event.status === 'string' ? event.status : '?';
      return `[studio] dispatch ${dispatchId} → ${status}`;
    }
    case 'turn_finished':
      return null; // turn 结束由 studio_response 接管显示
    default:
      return `[studio] event: ${type}`;
  }
}

function formatToolStart(toolName: string, input: string) {
  const parsed = input ? safeParseJson(input) : null;

  switch (toolName) {
    case 'read_file':
      return {
        label: '读文件',
        detail: typeof parsed?.path === 'string' ? shorten(parsed.path) : '读取文件内容',
      };
    case 'view_file_chunk':
      return {
        label: '看片段',
        detail: typeof parsed?.path === 'string'
          ? `${shorten(parsed.path)}${typeof parsed.startLine === 'number' ? `:${parsed.startLine}` : ''}${typeof parsed.endLine === 'number' ? `-${parsed.endLine}` : ''}`
          : '查看文件片段',
      };
    case 'stat_path':
      return {
        label: '看属性',
        detail: typeof parsed?.path === 'string' ? shorten(parsed.path) : '查看路径信息',
      };
    case 'write_file':
      return {
        label: '写文件',
        detail: typeof parsed?.path === 'string'
          ? `${parsed.append ? '追加' : '写入'} ${shorten(parsed.path)}`
          : '写入文件内容',
      };
    case 'update_file':
      return {
        label: '改文件',
        detail: typeof parsed?.path === 'string'
          ? `${parsed.replaceAll ? '批量替换' : '替换'} ${shorten(parsed.path)}`
          : '更新文件内容',
      };
    case 'multi_edit':
      return {
        label: '批量修改',
        detail: typeof parsed?.path === 'string'
          ? `${shorten(parsed.path)} · ${Array.isArray(parsed.edits) ? parsed.edits.length : '?'} 处`
          : '执行多组替换',
      };
    case 'apply_file_patch':
      return {
        label: '应用补丁',
        detail: typeof parsed?.path === 'string'
          ? `${shorten(parsed.path)} · ${Array.isArray(parsed.hunks) ? parsed.hunks.length : '?'} 段`
          : '按补丁更新文件',
      };
    case 'apply_unified_patch':
      return {
        label: '应用 diff',
        detail: typeof parsed?.cwd === 'string'
          ? `${shorten(parsed.cwd)} · -p${typeof parsed?.strip === 'number' ? parsed.strip : 0}${parsed?.dryRun ? ' · 预检' : ''}`
          : `当前目录 · -p${typeof parsed?.strip === 'number' ? parsed.strip : 0}${parsed?.dryRun ? ' · 预检' : ''}`,
      };
    case 'validate_structured_file':
      return {
        label: '验证结构',
        detail: typeof parsed?.path === 'string'
          ? `${shorten(parsed.path)}${typeof parsed?.schema === 'string' && parsed.schema !== 'none' ? ` · ${parsed.schema}` : ''}`
          : '验证结构化文件',
      };
    case 'move_path':
      return {
        label: '移动文件',
        detail: typeof parsed?.source === 'string' && typeof parsed?.destination === 'string'
          ? `${shorten(parsed.source, 28)} -> ${shorten(parsed.destination, 28)}`
          : '移动文件或目录',
      };
    case 'copy_path':
      return {
        label: '复制文件',
        detail: typeof parsed?.source === 'string' && typeof parsed?.destination === 'string'
          ? `${shorten(parsed.source, 28)} -> ${shorten(parsed.destination, 28)}`
          : '复制文件或目录',
      };
    case 'mkdir_path':
      return {
        label: '建目录',
        detail: typeof parsed?.path === 'string' ? shorten(parsed.path) : '创建目录',
      };
    case 'list_dir':
      return {
        label: '列目录',
        detail: typeof parsed?.path === 'string' ? shorten(parsed.path) : '查看目录内容',
      };
    case 'glob_search':
      return {
        label: '找文件',
        detail: typeof parsed?.pattern === 'string'
          ? `${shorten(parsed.pattern)}${typeof parsed.path === 'string' ? ` @ ${shorten(parsed.path, 24)}` : ''}`
          : '按模式搜索文件',
      };
    case 'grep_search':
      return {
        label: '搜内容',
        detail: typeof parsed?.query === 'string'
          ? `${shorten(parsed.query)}${typeof parsed.path === 'string' ? ` @ ${shorten(parsed.path, 24)}` : ''}`
          : '递归搜索文件内容',
      };
    case 'run_shell':
      return {
        label: '执行命令',
        detail: typeof parsed?.command === 'string' ? shorten(parsed.command) : '执行 shell 命令',
      };
    case 'download_file':
      return {
        label: '下载文件',
        detail: typeof parsed?.url === 'string' ? shorten(parsed.url) : '下载远程文件',
      };
    default:
      return {
        label: toolName,
        detail: input ? shorten(input) : '',
      };
  }
}

function formatToolProgress(toolName: string, detail: string) {
  if (!detail) {
    return '';
  }
  if (toolName === 'run_shell') {
    return shorten(detail, 80);
  }
  return shorten(detail, 80);
}

function formatToolResult(toolName: string, output: string, error: string) {
  if (error) {
    return `失败 · ${error.trim()}`;
  }

  const parsed = output ? safeParseJson(output) : null;
  if (toolName === 'capability_search') {
    const state = parsed?.update && typeof parsed.update === 'object'
      ? (parsed.update as Record<string, unknown>).capabilitySearchState
      : null;
    if (state && typeof state === 'object') {
      const stateRecord = state as Record<string, unknown>;
      const query = typeof stateRecord.query === 'string' && stateRecord.query.trim()
        ? stateRecord.query.trim()
        : null;
      const candidates = Array.isArray(stateRecord.candidates)
        ? stateRecord.candidates.flatMap((candidate) => {
            if (!candidate || typeof candidate !== 'object') return [];
            const record = candidate as Record<string, unknown>;
            const name = typeof record.name === 'string' ? record.name : null;
            if (!name) return [];
            const matchedTerms = Array.isArray(record.matchedTerms)
              ? record.matchedTerms.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
              : [];
            return [matchedTerms.length > 0 ? `${name} (${matchedTerms.join('|')})` : name];
          })
        : [];
      if (candidates.length > 0) {
        return `找到 capability：${candidates.join('、')}${query ? ` · query: ${query}` : ''}`;
      }
      return `未找到 capability 候选${query ? ` · query: ${query}` : ''}`;
    }
    return output || '已搜索 capability';
  }

  if (parsed?.ok) {
    switch (toolName) {
      case 'write_file':
        return typeof parsed.path === 'string'
          ? `已写入 ${shorten(parsed.path, 48)}`
          : '已写入';
      case 'view_file_chunk':
        return '已读取片段';
      case 'stat_path':
        return typeof parsed.path === 'string'
          ? `已查看 ${shorten(parsed.path, 48)}`
          : '已查看';
      case 'update_file':
        return typeof parsed.path === 'string'
          ? `已更新 ${shorten(parsed.path, 48)}`
          : '已更新';
      case 'multi_edit':
        return typeof parsed.path === 'string'
          ? `已批量修改 ${shorten(parsed.path, 48)}`
          : '已批量修改';
      case 'apply_file_patch':
        return typeof parsed.path === 'string'
          ? `已应用补丁 ${shorten(parsed.path, 48)}`
          : '已应用补丁';
      case 'apply_unified_patch':
        return typeof parsed.cwd === 'string'
          ? `${parsed.dryRun ? '预检通过' : '已应用'} ${shorten(parsed.cwd, 48)}`
          : (parsed.dryRun ? '预检通过' : '已应用 diff');
      case 'validate_structured_file':
        return typeof parsed.path === 'string'
          ? `已验证 ${shorten(parsed.path, 48)}`
          : '已验证结构';
      case 'move_path':
        return typeof parsed.destination === 'string'
          ? `已移动到 ${shorten(parsed.destination, 48)}`
          : '已移动';
      case 'copy_path':
        return typeof parsed.destination === 'string'
          ? `已复制到 ${shorten(parsed.destination, 48)}`
          : '已复制';
      case 'mkdir_path':
        return typeof parsed.path === 'string'
          ? `已创建 ${shorten(parsed.path, 48)}`
          : '已创建';
      case 'glob_search':
        return output ? `找到 ${shorten(output, 60)}` : '已完成搜索';
      case 'grep_search':
        return output ? `命中 ${shorten(output, 60)}` : '已完成搜索';
      case 'download_file':
        return typeof parsed.path === 'string'
          ? `已下载到 ${shorten(parsed.path, 48)}`
          : '已下载';
      default:
        return '已完成';
    }
  }

  if (toolName === 'list_dir') {
    return output ? `已列出 ${output}` : '已列目录';
  }
  if (toolName === 'read_file') {
    return output ? `已读取 ${output}` : '已读取';
  }
  if (toolName === 'run_shell') {
    return output ? `结果 ${output}` : '已执行';
  }
  return output || '已完成';
}

function wrapLine(line: string, width: number) {
  if (width <= 0) return [''];
  if (!line) return [''];
  const wrapped: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const char of Array.from(line)) {
    const charWidth = Math.max(1, stringWidth(char));
    if (currentWidth > 0 && currentWidth + charWidth > width) {
      wrapped.push(current);
      current = char;
      currentWidth = charWidth;
      continue;
    }
    current += char;
    currentWidth += charWidth;
  }
  if (current || wrapped.length === 0) {
    wrapped.push(current);
  }
  return wrapped;
}

function buildActiveToolLines(activeTools: ActiveTool[], now: number, width: number) {
  return activeTools.flatMap((tool, index) =>
    wrapLine(
      `${tool.label} · ${formatElapsed(tool.startedAt, now)}${tool.detail ? ` · ${tool.detail}` : ''}`,
      width,
    ).map((text, lineIndex) => ({
      id: `tool-${tool.name}-${index}-${lineIndex}`,
      text,
    })),
  );
}

function MessageBlock(props: {
  entry: Pick<MessageEntry, 'role' | 'timestamp' | 'text'>;
  petName: string;
  width: number;
}) {
  const timestamp = props.entry.timestamp ? `[${props.entry.timestamp}]` : '';

  if (props.entry.role === 'system') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {props.entry.text.split('\n').map((line, index) => (
          <Text key={`${props.entry.timestamp ?? 'system'}-${index}`} color="yellow" dimColor>
            {index === 0 ? `${timestamp} system  ` : '                 '}
            {line || ' '}
          </Text>
        ))}
      </Box>
    );
  }

  if (props.entry.role === 'user') {
    const label = `${timestamp} 你`;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>{label}</Text>
        <Box marginLeft={1}>
          <Text color="cyan" dimColor>&gt; </Text>
          <Box flexDirection="column" width={Math.max(20, props.width - 4)}>
          {props.entry.text.split('\n').map((line, index) => (
            <Text key={`${props.entry.timestamp ?? 'user'}-${index}`} color="cyan">
              {line || ' '}
            </Text>
          ))}
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="green" bold>
        {timestamp} {props.petName}
      </Text>
      <Box marginLeft={1}>
        <Text color="green" dimColor>| </Text>
        <Box flexDirection="column" width={Math.max(20, props.width - 4)}>
          <Markdown>{props.entry.text}</Markdown>
        </Box>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main TUI application
// ---------------------------------------------------------------------------

function TuiApp(props: { actorId: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [status, setStatus] = useState('初始化中');
  const [petName, setPetName] = useState('宠物');
  const [petSummary, setPetSummary] = useState('pet 未加载');
  const [messages, setMessages] = useState<MessageEntry[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingUi, setPendingUi] = useState<PendingUiState | null>(null);
  const [animationFrame, setAnimationFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [pendingInterrupt, setPendingInterrupt] = useState<PendingInterrupt | null>(null);
  const [studioMode, setStudioMode] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const busyRef = useRef(false);
  const lastInterruptAtRef = useRef(0);
  const pendingRef = useRef<{ requestId: string } | null>(null);
  const assistantDraftRef = useRef('');
  const interruptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Studio 模式持续期间共用一个 conversationId,这样 wiki 跨 turn 累积、
  // pet runtime 的 thread namespace 也保持一致
  const studioConversationIdRef = useRef<string | null>(null);
  const studioModeRef = useRef(false);

  const appendMessage = (role: MessageRole, text: string) => {
    setMessages((current) => trimItems([
      ...current,
      {
        id: randomUUID(),
        role,
        timestamp: formatNow(),
        text,
      },
    ], MAX_MESSAGES));
  };

  const finishRequest = (nextStatus = '就绪') => {
    if (interruptTimeoutRef.current) {
      clearTimeout(interruptTimeoutRef.current);
      interruptTimeoutRef.current = null;
    }
    busyRef.current = false;
    setBusy(false);
    setPendingUi(null);
    assistantDraftRef.current = '';
    setActiveTools([]);
    pendingRef.current = null;
    setStatus(nextStatus);
  };

  /** 发起一次 Studio turn(复用本会话的 conversationId) */
  const fireStudioRequest = (ws: WebSocket, userRequest: string) => {
    const requestId = randomUUID();
    busyRef.current = true;
    setBusy(true);
    setInputValue('');
    setStatus('Studio 编排中');
    setNow(Date.now());
    setPendingUi({
      startedAt: Date.now(),
      phase: 'thinking',
      charCount: 0,
    });
    assistantDraftRef.current = '';
    setActiveTools([]);
    appendMessage('user', `[studio] ${userRequest}`);
    pendingRef.current = { requestId };
    ws.send(JSON.stringify({
      type: 'studio_request',
      requestId,
      userRequest,
      ...(studioConversationIdRef.current
        ? { conversationId: studioConversationIdRef.current }
        : {}),
    }));
  };

  const submitInterruptDecision = (option: InterruptOption) => {
    const decision = option.message.trim();
    if (!decision) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendMessage('system', '未连接，无法提交确认。');
      return;
    }
    const requestId = randomUUID();
    setInputValue('');
    setPendingInterrupt(null);
    busyRef.current = true;
    setBusy(true);
    setStatus('提交确认');
    setNow(Date.now());
    setPendingUi({
      startedAt: Date.now(),
      phase: 'thinking',
      charCount: 0,
    });
    assistantDraftRef.current = '';
    pendingRef.current = { requestId };
    appendMessage('user', decision);
    ws.send(JSON.stringify({
      type: 'chat_request',
      requestId,
      message: decision,
      ...(option.resume !== undefined ? { resume: option.resume } : {}),
    }));
  };

  const interruptCurrentInput = () => {
    const ws = wsRef.current;
    const pending = pendingRef.current;
    if (!busyRef.current || !ws || ws.readyState !== WebSocket.OPEN || !pending) {
      return;
    }
    ws.send(JSON.stringify({
      type: 'interrupt_request',
      requestId: pending.requestId,
    }));
    lastInterruptAtRef.current = Date.now();
    setPendingUi((current) => current ? { ...current, phase: 'interrupting' } : current);
    setStatus('正在打断');
    if (interruptTimeoutRef.current) {
      clearTimeout(interruptTimeoutRef.current);
    }
    const interruptRequestId = pending.requestId;
    interruptTimeoutRef.current = setTimeout(() => {
      if (!busyRef.current || pendingRef.current?.requestId !== interruptRequestId) {
        return;
      }
      appendMessage('system', '打断请求已发送，本地先释放输入；迟到的旧响应会被忽略。');
      finishRequest('已请求打断');
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
        appendMessage('system', '已退出 Studio 模式');
        setInputValue('');
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        appendMessage('system', '未连接,无法发送');
        return;
      }
      if (busyRef.current) {
        appendMessage('system', '当前任务仍在进行中,按 Ctrl+C 或 Esc 打断');
        return;
      }
      // 进入 Studio 模式(若不在)
      if (!studioModeRef.current) {
        studioModeRef.current = true;
        studioConversationIdRef.current = randomUUID();
        setStudioMode(true);
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
      setMessages([]);
      setActiveTools([]);
      setPendingInterrupt(null);
      setInputValue('');
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'new_session' }));
      }
      setStatus('已创建新会话');
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

    if (busyRef.current) {
      appendMessage('system', '当前任务仍在进行中，按 Ctrl+C 或 Esc 打断');
      return;
    }

    // Studio 模式下:普通文本走 studio_request(沿用同一 conversationId)
    if (studioModeRef.current) {
      fireStudioRequest(ws, text);
      return;
    }

    const requestId = randomUUID();
    busyRef.current = true;
    setBusy(true);
    setInputValue('');
    setStatus('等待回复');
    setNow(Date.now());
    setPendingUi({
      startedAt: Date.now(),
      phase: 'thinking',
      charCount: 0,
    });
    assistantDraftRef.current = '';
    setActiveTools([]);
    appendMessage('user', text);
    pendingRef.current = {
      requestId,
    };

    ws.send(JSON.stringify({
      type: 'chat_request',
      requestId,
      message: text,
    }));
  };

  const handleWsMessage = (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      const pending = pendingRef.current;
      if (!pending || msg.requestId !== pending.requestId) {
        return;
      }

      if (msg.type === 'tool_log') {
        const phase = typeof msg.phase === 'string' ? msg.phase : 'event';
        const toolName = typeof msg.toolName === 'string' ? msg.toolName : 'unknown';
        const input = typeof msg.input === 'string' ? msg.input : '';
        const output = typeof msg.output === 'string' ? msg.output : '';
        const error = typeof msg.error === 'string' ? msg.error : '';

        setActiveTools((current) => {
          if (phase === 'start') {
            const summary = formatToolStart(toolName, input);
            const next = current.filter((tool) => tool.name !== toolName);
            next.push({
              name: toolName,
              label: summary.label,
              detail: summary.detail,
              startedAt: Date.now(),
            });
            return next;
          }
          if (phase === 'event') {
            return current.map((tool) => (
              tool.name === toolName
                ? { ...tool, detail: formatToolProgress(toolName, output || input || error) || tool.detail }
                : tool
            ));
          }
          return current.filter((tool) => tool.name !== toolName);
        });

        if (phase === 'end' || phase === 'error') {
          appendMessage('system', `${formatToolStart(toolName, input).label}：${formatToolResult(toolName, output, error)}`);
        }
        return;
      }

      if (msg.type === 'chat_token') {
        const token = typeof msg.token === 'string' ? msg.token : '';
        if (!token) return;
        assistantDraftRef.current += token;
        setPendingUi((current) => current ? {
          ...current,
          phase: 'replying',
          charCount: current.charCount + token.length,
        } : current);
        return;
      }

      if (msg.type === 'interrupting') {
        setPendingUi((current) => current ? { ...current, phase: 'interrupting' } : current);
        setStatus('正在打断');
        return;
      }

      if (msg.type === 'human_interrupt') {
        const prompt = typeof msg.prompt === 'string'
          ? msg.prompt.trim()
          : '当前流程需要你的确认，请直接回复继续或说明下一步。';
        const interruptPayload = msg.payload && typeof msg.payload === 'object'
          ? msg.payload as Record<string, unknown>
          : {};
        const petId = typeof msg.petId === 'string' && msg.petId
          ? msg.petId
          : undefined;
        setPendingInterrupt({
          kind: typeof interruptPayload.kind === 'string' ? interruptPayload.kind : 'interrupt',
          prompt,
          payload: interruptPayload,
          ...(petId ? { petId } : {}),
        });
        finishRequest(petId ? `等待你的决定(${petId})` : '等待你的决定');
        return;
      }

      if (msg.type === 'system_notice') {
        const notice = typeof msg.message === 'string' ? msg.message.trim() : '';
        if (notice) {
          appendMessage('system', notice);
        }
        return;
      }

      if (msg.type === 'chat_response') {
        const reply = typeof msg.message === 'string' ? msg.message.trim() : '';
        const finalText = assistantDraftRef.current.trim() || reply || '...';
        if (finalText) {
          appendMessage('assistant', finalText);
        }
        setPendingInterrupt(null);
        finishRequest();
        return;
      }

      if (msg.type === 'interrupted') {
        appendMessage('assistant', '[interrupted]');
        setPendingInterrupt(null);
        finishRequest('已打断');
        return;
      }

      if (msg.type === 'studio_turn_event') {
        const event = msg.event && typeof msg.event === 'object'
          ? msg.event as Record<string, unknown>
          : null;
        if (event) {
          const line = formatStudioTurnEvent(event);
          if (line) appendMessage('system', line);
        }
        return;
      }

      if (msg.type === 'studio_response') {
        const reply = typeof msg.reply === 'string' ? msg.reply.trim() : '';
        const outcome = typeof msg.outcome === 'string' ? msg.outcome : 'unknown';
        if (reply) {
          appendMessage('assistant', reply);
        } else {
          appendMessage('system', `[studio] turn ${outcome} (无最终输出)`);
        }
        if (outcome === 'stopped' && typeof msg.reason === 'string') {
          appendMessage('system', `[studio] stopped: ${msg.reason}`);
        }
        setPendingInterrupt(null);
        finishRequest();
        return;
      }

      if (msg.type === 'studio_error') {
        const message = typeof msg.message === 'string' ? msg.message : 'studio error';
        appendMessage('system', `[studio 出错] ${message}`);
        setPendingInterrupt(null);
        finishRequest('Studio 出错,已恢复输入');
        return;
      }

      if (msg.type === 'error') {
        const error = typeof msg.message === 'string' ? msg.message : 'internal error';
        appendMessage('system', `出错: ${error}`);
        setPendingInterrupt(null);
        finishRequest('出错，已恢复输入');
      }
    } catch {
      // ignore malformed messages
    }
  };

  useEffect(() => {
    if (!busy) {
      setPendingUi(null);
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
    let disposed = false;

    const init = async () => {
      setStatus('连接本地服务');
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
            setStatus('未连接');
            return;
          }
          const retryIndex = attempt + 1;
          const retryText = `本地服务暂不可用，${LOCAL_SERVER_CONNECT_RETRY_DELAY_MS / 1000}s 后重试 ${retryIndex}/${LOCAL_SERVER_CONNECT_RETRIES}`;
          setStatus(retryText);
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
                  role: item.role,
                  text: item.text,
                } satisfies MessageEntry];
              }
              return [];
            })
            : [];
          if (restored.length > 0) {
            setMessages(trimItems(restored, MAX_MESSAGES));
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
        setReady(true);
        setStatus('就绪');
      });

      ws.on('message', handleWsMessage);

      ws.on('close', () => {
        if (disposed) return;
        setReady(false);
        setStatus('连接断开');
        wsRef.current = null;
      });

      ws.on('error', (err) => {
        if (disposed) return;
        appendMessage('system', `WS error: ${err.message}`);
      });

      try {
        const context = await loadAgentContext(props.actorId);
        if (disposed) return;
        setPetName(context.pet.name);
        setPetSummary(buildPetSummary(context));
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
      setStatus(`初始化失败: ${message}`);
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
      if (busyRef.current) {
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
      if (busyRef.current) {
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
            setPendingInterrupt(null);
            setInputValue('');
            setStatus('已关闭确认面板 · 可自由输入');
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

export async function runTui(opts: { dryRun: boolean }) {
  void opts;
  const actorId = await ensureActorSelected({ interactive: true });
  const instance = render(<TuiApp actorId={actorId} />);
  await instance.waitUntilExit();
}
