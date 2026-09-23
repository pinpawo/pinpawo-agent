import { tool } from '@langchain/core/tools';
import type { StructuredTool, ToolRuntime } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import type { SubagentRuntimeContext } from '@pinpawo/pet-agent';
import { z } from 'zod';
import type {
  BrowserExtractOptions,
  BrowserWaitState,
} from './session';
import { formatBrowserToolError } from './errors';
import { buildBrowserScreenshotMessages } from './screenshot';
import { BROWSER_TOOLKIT_NAME } from './constants';
import {
  isBrowserRuntimePort,
  type BrowserRuntimeCallContext,
  type BrowserRuntimePort,
} from './runtimePort';

type BrowserTargetInput = { selector?: string; ref?: string };

const browserTargetFields = {
  selector: z.string().min(1).optional().describe('CSS 或 text=... 选择器；与 ref 二选一'),
  ref: z.string().min(1).optional().describe('最近一次 snapshot 返回的稳定元素 ref；与 selector 二选一'),
};

function readBrowserTarget(input: BrowserTargetInput) {
  if ((input.selector ? 1 : 0) + (input.ref ? 1 : 0) !== 1) {
    throw new Error('exactly one of selector or ref is required');
  }
  return { selector: input.selector, ref: input.ref };
}

type BrowserToolRuntime = ToolRuntime<unknown, SubagentRuntimeContext>;

function resolveBrowserCall(runtime: BrowserToolRuntime): {
  browser: BrowserRuntimePort;
  context: BrowserRuntimeCallContext;
} {
  const scope = runtime.context?.executionScope;
  if (!scope?.threadId) {
    throw new Error('Browser tool call requires a threadId.');
  }
  if (!scope.workdir) {
    throw new Error('Browser tool call requires a workdir.');
  }
  const browser = runtime.context?.toolkitRuntimes?.[BROWSER_TOOLKIT_NAME];
  if (!isBrowserRuntimePort(browser)) {
    throw new Error('Browser tool call requires an active Browser Runtime.');
  }
  return {
    browser,
    context: {
      threadId: scope.threadId,
      workdir: scope.workdir,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    },
  };
}

export function createBrowserTools(): StructuredTool[] {
const browserOpenTool = tool(
  async ({ url }: { url: string }, runtime: BrowserToolRuntime) => {
    try {
      const { browser, context } = resolveBrowserCall(runtime);
      return await browser.open(context, url);
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_open',
    description:
      '在用户的 Chrome 中打开一个网页 URL，返回页面标题、文本预览、截断元数据和可交互元素。\n' +
      '- 如果返回 truncated/hasMore=true，先用 browser_extract({ offset, limit }) 分块读取全文，再总结或判断页面内容。',
    schema: z.object({
      url: z.string().url().describe('要打开的网页 URL'),
    }),
  },
);

const browserSnapshotTool = tool(
  async (_input, runtime: BrowserToolRuntime) => {
    try {
      const { browser, context } = resolveBrowserCall(runtime);
      return await browser.snapshot(context);
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_snapshot',
    description:
      '查看当前浏览器页面，返回标题、URL、文本预览、截断元数据和可交互元素概览。' +
      '如果 truncated/hasMore=true，使用 browser_extract({ offset, limit }) 分块读取全文。',
    schema: z.object({}),
  },
);

const browserClickTool = tool(
  async (input: BrowserTargetInput, runtime: BrowserToolRuntime) => {
    try {
      const { browser, context } = resolveBrowserCall(runtime);
      return await browser.click(
        context,
        readBrowserTarget(input),
      );
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_click',
    description:
      '点击当前页面上的元素。优先使用最近 snapshot 返回的 ref；也支持 CSS 或 text=... selector。',
    schema: z.object(browserTargetFields).refine(
      (value) => Boolean(value.selector) !== Boolean(value.ref),
      { message: 'exactly one of selector or ref is required' },
    ),
  },
);

const browserTypeTool = tool(
  async (
    { selector, ref, text, submit }: BrowserTargetInput & { text: string; submit?: boolean },
    runtime: BrowserToolRuntime,
  ) => {
    try {
      const { browser, context } = resolveBrowserCall(runtime);
      return await browser.type(
        context,
        readBrowserTarget({ selector, ref }),
        text,
        submit ?? false,
      );
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_type',
    description: '在页面输入框中输入文本；优先使用最近 snapshot 返回的 ref；submit=true 代表输入后按 Enter 提交。',
    schema: z.object({
      ...browserTargetFields,
      text: z.string().describe('要输入的文本'),
      submit: z.boolean().optional().describe('输入后是否按 Enter 提交，默认 false'),
    }).refine(
      (value) => Boolean(value.selector) !== Boolean(value.ref),
      { message: 'exactly one of selector or ref is required' },
    ),
  },
);

const browserScrollTool = tool(
  async (
    { deltaX, deltaY, selector, ref }: BrowserTargetInput & { deltaX?: number; deltaY?: number },
    runtime: BrowserToolRuntime,
  ) => {
    try {
      const target = selector || ref ? readBrowserTarget({ selector, ref }) : undefined;
      const { browser, context } = resolveBrowserCall(runtime);
      return await browser.scroll(context, {
        deltaX: deltaX ?? 0,
        deltaY: deltaY ?? 600,
        target,
      });
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_scroll',
    description: '滚动当前页面；默认向下滚动 600 CSS 像素。可指定 ref/selector，将指针移到该元素后滚动。',
    schema: z.object({
      deltaX: z.number().min(-10000).max(10000).optional().describe('水平滚动量，默认 0'),
      deltaY: z.number().min(-10000).max(10000).optional().describe('垂直滚动量，默认 600'),
      ...browserTargetFields,
    }).refine(
      (value) => !(value.selector && value.ref),
      { message: 'selector and ref cannot both be provided' },
    ),
  },
);

const browserWaitTool = tool(
  async ({ selector, ref, timeoutMs, state }: BrowserTargetInput & {
    timeoutMs?: number;
    state?: BrowserWaitState;
  }, runtime: BrowserToolRuntime) => {
    try {
      const target = selector || ref ? readBrowserTarget({ selector, ref }) : undefined;
      const { browser, context } = resolveBrowserCall(runtime);
      return await browser.wait(
        context,
        target,
        timeoutMs ?? 3_000,
        state ?? 'visible',
      );
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_wait',
    description: '等待页面条件。可等待某个 ref/selector 对应的元素变为 visible（默认）或 hidden；不指定目标时等待指定毫秒数。',
    schema: z.object({
      ...browserTargetFields,
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(30000)
        .optional()
        .describe('等待毫秒数，默认 3000'),
      state: z
        .enum(['visible', 'hidden'])
        .optional()
        .describe('目标等待状态，默认 visible；hidden 可用于等待遮罩、loading 或 popup 元素消失'),
    }).refine(
      (value) => !(value.selector && value.ref),
      { message: 'selector and ref cannot both be provided' },
    ),
  },
);

const browserExtractTool = tool(
  async (
    { selector, offset, limit }: BrowserExtractOptions,
    runtime: BrowserToolRuntime,
  ) => {
    try {
      const { browser, context } = resolveBrowserCall(runtime);
      return await browser.extract(
        context,
        { selector, offset, limit },
      );
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_extract',
    description:
      '分块提取当前页面文本，返回 JSON：text、textLength、returnedTextLength、offset、textEndOffset、hasMore、nextOffset。\n' +
      '- 不给 selector 时读取 document.body/body 的全文分块，不需要从截断 snapshot 里猜 CSS selector。\n' +
      '- 给 selector 时读取该元素文本分块。\n' +
      '- offset 默认 0；limit 默认 50000，最大 100000。hasMore=true 时继续用 nextOffset 读取下一块。',
    schema: z.object({
      selector: z.string().optional().describe('可选的元素选择器'),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('从全文第几个字符开始提取，默认 0。继续读取时使用上次返回的 nextOffset'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100000)
        .optional()
        .describe('本次最多返回多少字符，默认 50000，最大 100000'),
    }),
  },
);

const browserCloseTool = tool(
  async (_input, runtime: BrowserToolRuntime) => {
    try {
      const { browser, context } = resolveBrowserCall(runtime);
      return await browser.close(context);
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_close',
    description: '关闭当前浏览器会话，释放资源。',
    schema: z.object({}),
  },
);

const browserScreenshotTool = tool(
  async (_input, runtime: BrowserToolRuntime) => {
    try {
      const { browser, context } = resolveBrowserCall(runtime);
      const result = await browser.screenshot(context);
      // The screenshot needs its own user message to carry the image, so this
      // tool writes the graph update itself instead of returning tool content.
      return new Command({
        update: {
          messages: await buildBrowserScreenshotMessages(
            result,
            runtime.toolCallId,
            context.workdir,
          ),
        },
      });
    } catch (err) {
      return formatBrowserToolError(err);
    }
  },
  {
    name: 'browser_screenshot',
    description: '截取当前可见浏览器视口并保存到当前 workdir 的 .pinpawo/browser/screenshots 目录。',
    schema: z.object({}),
  },
);

  return [
    browserOpenTool,
    browserSnapshotTool,
    browserClickTool,
    browserTypeTool,
    browserScrollTool,
    browserWaitTool,
    browserExtractTool,
    browserScreenshotTool,
    browserCloseTool,
  ];
}

export const browserTools = createBrowserTools();
