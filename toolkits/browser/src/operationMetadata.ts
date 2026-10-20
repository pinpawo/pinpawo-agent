import {
  readBoolean,
  readJsonRecord,
  readNumber,
  readString,
  type OperationSummary,
  type ToolOperationMetadata,
} from '@pinpawo/pet-agent';

function browserOpenInputSummary(input: unknown): OperationSummary | null {
  const url = readString(readJsonRecord(input), 'url');
  return url ? { target: url, summary: '打开网页' } : null;
}

function elementTarget(record: Record<string, unknown> | null) {
  return readString(record, 'ref') ?? readString(record, 'selector');
}

function selectorInputSummary(action: string, input: unknown): OperationSummary | null {
  const target = elementTarget(readJsonRecord(input));
  return target ? { target, summary: `${action} ${target}` } : null;
}

function typeInputSummary(input: unknown): OperationSummary | null {
  const record = readJsonRecord(input);
  const target = elementTarget(record);
  // The typed text may be a credential, so only its length is shown.
  const length = readString(record, 'text')?.length;
  return target
    ? {
        target,
        summary: `输入到 ${target}${length === undefined ? '' : `（${length} 字）`}${readBoolean(record, 'submit') ? '并提交' : ''}`,
      }
    : null;
}

function waitInputSummary(input: unknown): OperationSummary | null {
  const record = readJsonRecord(input);
  const target = elementTarget(record);
  const timeoutMs = readNumber(record, 'timeoutMs');
  return {
    target,
    summary: `${target ? `等待 ${target}` : '等待页面'}${timeoutMs === undefined ? '' : `（最多 ${timeoutMs}ms）`}`,
  };
}

function scrollInputSummary(input: unknown): OperationSummary | null {
  const record = readJsonRecord(input);
  return {
    target: elementTarget(record),
    summary: `滚动页面 ${readNumber(record, 'deltaY') ?? 600}px`,
  };
}

function browserExtractInputSummary(input: unknown): OperationSummary | null {
  const selector = readString(readJsonRecord(input), 'selector');
  return { target: selector, summary: selector ? `提取 ${selector}` : '提取页面文本' };
}

export const browserOperationMetadata: Record<string, ToolOperationMetadata> = {
  browser_open: {
    title: '打开网页',
    summarize: browserOpenInputSummary,
  },
  browser_snapshot: {
    title: '查看页面',
    summarize: () => ({ summary: '查看当前页面' }),
  },
  browser_click: {
    title: '点击页面',
    summarize: (input) => selectorInputSummary('点击', input),
  },
  browser_type: {
    title: '输入文本',
    summarize: typeInputSummary,
  },
  browser_scroll: {
    title: '滚动页面',
    summarize: scrollInputSummary,
  },
  browser_wait: {
    title: '等待页面',
    summarize: waitInputSummary,
  },
  browser_extract: {
    title: '提取页面文本',
    summarize: browserExtractInputSummary,
  },
  browser_screenshot: {
    title: '截取页面',
    summarize: () => ({ summary: '截取当前浏览器视口' }),
  },
  browser_close: {
    title: '关闭浏览器',
    summarize: () => ({ summary: '关闭当前浏览器会话' }),
  },
};
