import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { browserSession } from './session';
import type { BrowserExtractOptions } from './session';

const browserOpenTool = tool(
  async ({ url, headless }: { url: string; headless?: boolean }) => {
    try {
      return await browserSession.open(url, { headless });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'browser_open',
    description:
      '用默认浏览器会话打开一个网页 URL，返回页面标题、文本预览、截断元数据和可交互元素。\n' +
      '- 如果返回 truncated/hasMore=true，先用 browser_extract({ offset, limit }) 分块读取全文，再总结或判断页面内容。\n' +
      '- headless: 默认 false（显示浏览器窗口）。需要登录或处理验证码时保持 false，让用户可以手动操作；纯抓取时可设为 true。\n' +
      '- session 固定使用 default；不要根据 URL、网站名或任务名创建特殊 session。',
    schema: z.object({
      url: z.string().url().describe('要打开的网页 URL'),
      headless: z
        .boolean()
        .optional()
        .describe('是否无头模式。默认 false（显示窗口）。需要用户交互（登录/验证码）时保持 false'),
    }),
  },
);

const browserOpenWithSessionTool = tool(
  async ({ url, session, headless }: { url: string; session: string; headless?: boolean }) => {
    try {
      return await browserSession.open(url, { headless, session: session.trim() });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'browser_open_with_session',
    description:
      '用用户明确指定的浏览器会话打开网页，返回页面标题、文本预览、截断元数据和可交互元素。\n' +
      '- 如果返回 truncated/hasMore=true，先用 browser_extract({ offset, limit }) 分块读取全文，再总结或判断页面内容。\n' +
      '- 只有用户明确要求隔离登录状态、复用某个专属浏览器会话，或直接给出会话名称时才使用。\n' +
      '- 不要根据 URL、网站名、域名、平台名或任务名自行生成会话名称；普通网页访问一律使用 browser_open 的 default 会话。\n' +
      '- 浏览器会话名称不是本机 Chrome profile 名；本机 Chrome user-data-dir 请使用 browser_open_with_profile。',
    schema: z.object({
      url: z.string().url().describe('要打开的网页 URL'),
      session: z
        .string()
        .min(1)
        .describe('用户明确指定的浏览器会话名称'),
      headless: z
        .boolean()
        .optional()
        .describe('是否无头模式。默认 false（显示窗口）。需要用户交互（登录/验证码）时保持 false'),
    }),
  },
);

const browserOpenWithProfileTool = tool(
  async ({ url, userDataDir, headless }: { url: string; userDataDir: string; headless?: boolean }) => {
    try {
      return await browserSession.openWithProfile(url, userDataDir, { headless });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'browser_open_with_profile',
    description:
      '用显式指定的本机浏览器 profile 打开网页，返回页面标题、文本预览、截断元数据和可交互元素。\n' +
      '- 如果返回 truncated/hasMore=true，先用 browser_extract({ offset, limit }) 分块读取全文，再总结或判断页面内容。\n' +
      '- userDataDir: 本机 Chrome/Chromium 的 user-data-dir 目录，等价于 Chrome 的 --user-data-dir 参数；模型必须填写用户提供或已经确认过的本地目录。\n' +
      '- 这会直接使用该目录作为持久化浏览器上下文。若目录正被 Chrome 或其他 browser session 使用，可能因为 profile lock / ProcessSingleton 打不开；此时需要用户关闭占用的浏览器，或先复制 profile 到临时目录再使用。\n' +
      '- headless: 默认 false（显示浏览器窗口）。需要登录、验证码或人工操作时保持 false。',
    schema: z.object({
      url: z.string().url().describe('要打开的网页 URL'),
      userDataDir: z
        .string()
        .min(1)
        .describe('本机 Chrome/Chromium user-data-dir 目录路径，支持绝对路径或 ~/ 开头路径'),
      headless: z
        .boolean()
        .optional()
        .describe('是否无头模式。默认 false（显示窗口）。需要用户交互时保持 false'),
    }),
  },
);

const browserSnapshotTool = tool(
  async () => {
    try {
      return await browserSession.snapshot();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
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
  async ({ selector }: { selector: string }) => {
    try {
      return await browserSession.click(selector);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'browser_click',
    description:
      '点击当前页面上的元素。selector 支持 CSS 选择器或 text=... 形式。',
    schema: z.object({
      selector: z
        .string()
        .min(1)
        .describe('元素选择器，例如 "#submit" 或 "text=登录"'),
    }),
  },
);

const browserTypeTool = tool(
  async ({ selector, text, submit }: { selector: string; text: string; submit?: boolean }) => {
    try {
      return await browserSession.type(selector, text, submit ?? false);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'browser_type',
    description: '在页面输入框中输入文本；submit=true 代表输入后按 Enter 提交。',
    schema: z.object({
      selector: z.string().min(1).describe('输入框选择器'),
      text: z.string().describe('要输入的文本'),
      submit: z.boolean().optional().describe('输入后是否按 Enter 提交，默认 false'),
    }),
  },
);

const browserWaitTool = tool(
  async ({ selector, timeoutMs }: { selector?: string; timeoutMs?: number }) => {
    try {
      return await browserSession.wait(selector, timeoutMs ?? 3_000);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'browser_wait',
    description: '等待页面稳定。可等待某个 selector 出现，或等待指定毫秒数。',
    schema: z.object({
      selector: z.string().optional().describe('等待出现的选择器'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(30000)
        .optional()
        .describe('等待毫秒数，默认 3000'),
    }),
  },
);

const browserExtractTool = tool(
  async ({ selector, offset, limit }: BrowserExtractOptions) => {
    try {
      return await browserSession.extract({ selector, offset, limit });
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
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
  async () => {
    try {
      return await browserSession.close();
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'browser_close',
    description: '关闭当前浏览器会话，释放资源。',
    schema: z.object({}),
  },
);

const browserSessionTool = tool(
  async ({ action }: { action: 'list' }) => {
    try {
      if (action === 'list') {
        const sessions = await browserSession.listSessions();
        if (sessions.length === 0) {
          return '暂无已保存的浏览器会话。browser_open 默认使用 default；明确传入 session 时会创建对应会话。';
        }
        return `已保存的浏览器会话：\n${sessions.map((s) => `  - ${s}`).join('\n')}`;
      }

      return 'Error: unknown action';
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  },
  {
    name: 'browser_session',
    description:
      '管理浏览器会话（登录状态）。\n' +
      '- list: 列出所有已保存的浏览器会话。\n' +
      'browser_open 省略 session 时使用 default；明确传入 session 时使用对应的独立登录状态。',
    schema: z.object({
      action: z.enum(['list']).describe('"list" 列出已有浏览器会话'),
    }),
  },
);

export const browserTools: StructuredTool[] = [
  browserOpenTool,
  browserOpenWithSessionTool,
  browserOpenWithProfileTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserWaitTool,
  browserExtractTool,
  browserCloseTool,
  browserSessionTool,
];
