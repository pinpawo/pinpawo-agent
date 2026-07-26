import type { ToolOperationMetadata, ToolOperationSummary } from '@pinpawo/pet-agent';
import {
  readBoolean,
  readJsonRecord,
  readNumber,
  readString,
} from '../operationMetadata';

function compactText(value: string, max = 80) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function rawStringOutputSummary(output: unknown): ToolOperationSummary | null {
  if (typeof output !== 'string') return null;
  const summary = compactText(output);
  return summary ? { summary } : null;
}

function browserErrorSummary(error: unknown): ToolOperationSummary | null {
  if (error === undefined || error === null) return null;
  if (error instanceof Error) return { summary: compactText(error.message) || 'browser error' };
  if (typeof error === 'string') return { summary: compactText(error) || 'browser error' };
  return { summary: compactText(String(error)) || 'browser error' };
}

function browserSnapshotSummary(output: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(output);
  if (!record) return rawStringOutputSummary(output);
  const title = readString(record, 'title');
  const url = readString(record, 'url');
  const text = readString(record, 'text');
  const textLength = readNumber(record, 'textLength') ?? text?.length;
  const returnedTextLength = readNumber(record, 'returnedTextLength') ?? text?.length;
  const truncated = readBoolean(record, 'truncated');
  const hasMore = readBoolean(record, 'hasMore');
  const nextTextOffset = readNumber(record, 'nextTextOffset');
  if (!title && !url && !text) return null;
  return {
    target: url,
    summary: title
      ? `页面：${title}${truncated || hasMore ? '（文本已截断）' : ''}`
      : text
        ? compactText(text)
        : undefined,
    details: {
      title,
      url,
      textLength,
      returnedTextLength,
      truncated,
      hasMore,
      nextTextOffset,
    },
  };
}

function browserExtractInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const selector = readString(record, 'selector');
  const offset = readNumber(record, 'offset');
  const limit = readNumber(record, 'limit');
  return {
    target: selector,
    summary: selector ? `提取 ${selector}` : '提取页面文本',
    details: {
      selector,
      offset,
      limit,
    },
  };
}

function browserExtractOutputSummary(output: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(output);
  if (!record) return rawStringOutputSummary(output);

  const text = readString(record, 'text');
  const textLength = readNumber(record, 'textLength') ?? text?.length;
  const returnedTextLength = readNumber(record, 'returnedTextLength') ?? text?.length;
  const hasMore = readBoolean(record, 'hasMore');
  const nextOffset = readNumber(record, 'nextOffset');
  const selector = readString(record, 'selector');

  return {
    target: selector,
    summary: typeof returnedTextLength === 'number' && typeof textLength === 'number'
      ? `提取文本 ${returnedTextLength}/${textLength} 字${hasMore ? '（还有更多）' : ''}`
      : text
        ? compactText(text)
        : '提取页面文本',
    details: {
      selector,
      textLength,
      returnedTextLength,
      hasMore,
      nextOffset,
    },
  };
}

function browserOpenInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const url = readString(record, 'url');
  const headless = readBoolean(record, 'headless');
  return url
    ? {
        target: url,
        summary: '打开网页',
        details: {
          headless,
        },
      }
    : null;
}

function browserOpenWithSessionInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const url = readString(record, 'url');
  const session = readString(record, 'session');
  const headless = readBoolean(record, 'headless');
  return url || session
    ? {
        target: url,
        summary: session ? `打开会话 ${session}` : '打开浏览器会话',
        details: {
          session,
          headless,
        },
      }
    : null;
}

function browserOpenWithProfileInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const url = readString(record, 'url');
  const headless = readBoolean(record, 'headless');
  return url
    ? {
        target: url,
        summary: '使用本机 profile 打开网页',
        details: {
          profile: 'provided',
          headless,
        },
      }
    : null;
}

function selectorInputSummary(action: string, input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const selector = readString(record, 'selector');
  const ref = readString(record, 'ref');
  const target = ref ?? selector;
  return target
    ? {
        target,
        summary: `${action} ${target}`,
        details: {
          selector,
          ...(ref ? { ref } : {}),
        },
      }
    : null;
}

function typeInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const selector = readString(record, 'selector');
  const ref = readString(record, 'ref');
  const text = readString(record, 'text');
  const submit = readBoolean(record, 'submit');
  const target = ref ?? selector;
  return target
    ? {
        target,
        summary: `输入到 ${target}`,
        details: {
          selector,
          ...(ref ? { ref } : {}),
          submit,
          textLength: text?.length,
        },
      }
    : null;
}

function waitInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const selector = readString(record, 'selector');
  const ref = readString(record, 'ref');
  const timeoutMs = readNumber(record, 'timeoutMs');
  const target = ref ?? selector;
  return {
    target,
    summary: target ? `等待 ${target}` : '等待页面',
    details: {
      selector,
      ...(ref ? { ref } : {}),
      timeoutMs,
    },
  };
}

function scrollInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const selector = readString(record, 'selector');
  const ref = readString(record, 'ref');
  const deltaX = readNumber(record, 'deltaX');
  const deltaY = readNumber(record, 'deltaY');
  const target = ref ?? selector;
  return {
    target,
    summary: `滚动页面 ${deltaY ?? 600}px`,
    details: { selector, ref, deltaX, deltaY },
  };
}

function browserSessionInputSummary(input: unknown): ToolOperationSummary | null {
  const record = readJsonRecord(input);
  const action = readString(record, 'action');
  return action
    ? {
        summary: action === 'list' ? '列出浏览器会话' : action,
        details: {
          action,
        },
      }
    : null;
}

export const browserOperationMetadata: Record<string, ToolOperationMetadata> = {
  browser_open: {
    title: '打开网页',
    summarizeInput: browserOpenInputSummary,
    summarizeOutput: browserSnapshotSummary,
    summarizeError: browserErrorSummary,
  },
  browser_open_with_session: {
    title: '打开浏览器会话',
    summarizeInput: browserOpenWithSessionInputSummary,
    summarizeOutput: browserSnapshotSummary,
    summarizeError: browserErrorSummary,
  },
  browser_open_with_profile: {
    title: '打开浏览器 profile',
    summarizeInput: browserOpenWithProfileInputSummary,
    summarizeOutput: browserSnapshotSummary,
    summarizeError: browserErrorSummary,
  },
  browser_snapshot: {
    title: '查看页面',
    summarizeInput: () => ({ summary: '查看当前页面' }),
    summarizeOutput: browserSnapshotSummary,
    summarizeError: browserErrorSummary,
  },
  browser_click: {
    title: '点击页面',
    summarizeInput: (input) => selectorInputSummary('点击', input),
    summarizeOutput: browserSnapshotSummary,
    summarizeError: browserErrorSummary,
  },
  browser_type: {
    title: '输入文本',
    summarizeInput: typeInputSummary,
    summarizeOutput: browserSnapshotSummary,
    summarizeError: browserErrorSummary,
  },
  browser_scroll: {
    title: '滚动页面',
    summarizeInput: scrollInputSummary,
    summarizeOutput: browserSnapshotSummary,
    summarizeError: browserErrorSummary,
  },
  browser_wait: {
    title: '等待页面',
    summarizeInput: waitInputSummary,
    summarizeOutput: browserSnapshotSummary,
    summarizeError: browserErrorSummary,
  },
  browser_extract: {
    title: '提取页面文本',
    summarizeInput: browserExtractInputSummary,
    summarizeOutput: browserExtractOutputSummary,
    summarizeError: browserErrorSummary,
  },
  browser_screenshot: {
    title: '截取页面',
    summarizeInput: () => ({ summary: '截取当前浏览器视口' }),
    summarizeOutput: rawStringOutputSummary,
    summarizeError: browserErrorSummary,
  },
  browser_close: {
    title: '关闭浏览器',
    summarizeInput: () => ({ summary: '关闭当前浏览器会话' }),
    summarizeOutput: rawStringOutputSummary,
    summarizeError: browserErrorSummary,
  },
  browser_session: {
    title: '管理浏览器会话',
    summarizeInput: browserSessionInputSummary,
    summarizeOutput: rawStringOutputSummary,
    summarizeError: browserErrorSummary,
  },
};
