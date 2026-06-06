import type { ToolkitOperationMetadata, ToolkitOperationSummary } from '@pinpawo/pet-agent';
import {
  readBoolean,
  readJsonRecord,
  readNumber,
  readRecord,
  readString,
} from '../../plugins/operationMetadata';

function browserSnapshotSummary(output: unknown): ToolkitOperationSummary | null {
  const record = readJsonRecord(output);
  if (!record) return null;
  const title = readString(record, 'title');
  const url = readString(record, 'url');
  return title || url
    ? {
        target: url,
        summary: title ? `页面：${title}` : undefined,
        details: {
          title,
          url,
        },
      }
    : null;
}

function browserOpenInputSummary(input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
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

function browserOpenWithSessionInputSummary(input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
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

function browserOpenWithProfileInputSummary(input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
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

function selectorInputSummary(action: string, input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
  const selector = readString(record, 'selector');
  return selector
    ? {
        target: selector,
        summary: `${action} ${selector}`,
        details: {
          selector,
        },
      }
    : null;
}

function typeInputSummary(input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
  const selector = readString(record, 'selector');
  const text = readString(record, 'text');
  const submit = readBoolean(record, 'submit');
  return selector
    ? {
        target: selector,
        summary: `输入到 ${selector}`,
        details: {
          selector,
          submit,
          textLength: text?.length,
        },
      }
    : null;
}

function waitInputSummary(input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
  const selector = readString(record, 'selector');
  const timeoutMs = readNumber(record, 'timeoutMs');
  return {
    target: selector,
    summary: selector ? `等待 ${selector}` : '等待页面',
    details: {
      selector,
      timeoutMs,
    },
  };
}

function browserSessionInputSummary(input: unknown): ToolkitOperationSummary | null {
  const record = readRecord(input);
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

export const browserToolkitOperationMetadata: Record<string, ToolkitOperationMetadata> = {
  browser_open: {
    title: '打开网页',
    summarizeInput: browserOpenInputSummary,
    summarizeOutput: browserSnapshotSummary,
  },
  browser_open_with_session: {
    title: '打开浏览器会话',
    summarizeInput: browserOpenWithSessionInputSummary,
    summarizeOutput: browserSnapshotSummary,
  },
  browser_open_with_profile: {
    title: '打开浏览器 profile',
    summarizeInput: browserOpenWithProfileInputSummary,
    summarizeOutput: browserSnapshotSummary,
  },
  browser_snapshot: {
    title: '查看页面',
    summarizeInput: () => ({ summary: '查看当前页面' }),
    summarizeOutput: browserSnapshotSummary,
  },
  browser_click: {
    title: '点击页面',
    summarizeInput: (input) => selectorInputSummary('点击', input),
    summarizeOutput: browserSnapshotSummary,
  },
  browser_type: {
    title: '输入文本',
    summarizeInput: typeInputSummary,
    summarizeOutput: browserSnapshotSummary,
  },
  browser_wait: {
    title: '等待页面',
    summarizeInput: waitInputSummary,
    summarizeOutput: browserSnapshotSummary,
  },
  browser_extract: {
    title: '提取页面文本',
    summarizeInput: (input) => selectorInputSummary('提取', input),
  },
  browser_close: {
    title: '关闭浏览器',
    summarizeInput: () => ({ summary: '关闭当前浏览器会话' }),
  },
  browser_session: {
    title: '管理浏览器会话',
    summarizeInput: browserSessionInputSummary,
  },
};
