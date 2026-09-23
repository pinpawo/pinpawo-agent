import {
  defineToolkit,
  ReviewPolicies,
  type AgentToolkit,
  type ToolReviewPolicy,
} from '@pinpawo/pet-agent';
import { BROWSER_TOOLKIT_NAME } from './constants';
import { browserTools } from './tools';
import { browserOperationMetadata } from './operationMetadata';
import { BrowserRuntime } from './runtime';
import { BrowserExtensionBridge } from './drivers/chromeExtension/bridge';

export { BROWSER_TOOLKIT_NAME } from './constants';

const browserToolkitInstructions = [
  '你负责需要真实浏览器参与的网页访问、页面交互、登录态复用、JS 渲染内容读取和页面内容提取。',
  '优先使用 browser_open 打开目标页面，再根据页面状态使用 browser_snapshot、browser_click、browser_type、browser_scroll、browser_wait、browser_extract 或 browser_screenshot。',
  '浏览器操作通过 Chrome 扩展在用户自己的 Chrome 中进行，沿用其登录状态；需要登录、验证码或用户手动操作时，请用户在该 Chrome 中完成。',
  '使用 snapshot 返回的 ref 进行 click/type/wait 最稳定；ref 在下一次页面变化或 snapshot 后可能失效，遇到 stale reference 时重新 snapshot。',
  'browser_open、browser_snapshot、点击、输入和等待返回的是页面预览；如果结果里的 truncated 或 hasMore 为 true，说明模型只看到了片段。',
  '页面需要视觉判断时使用 browser_screenshot；截图会直接作为图片给到你，看完就基于结论继续操作。',
  '长文章、Gist、文档、GitHub 页面或搜索结果页在总结、引用、判断前，必须用 browser_extract({ offset, limit }) 按 nextOffset 分块读取，直到 hasMore 为 false。',
  'browser_extract 不给 selector 时会读取当前页面正文全文分块；不要为了绕过截断而从不完整 snapshot 里猜 selector。',
  '点击或提交打开 popup/新标签页时，browser capability 会跟随新目标；新目标关闭后会尽量回到上一目标。',
  '只允许继续读取和操作同源 popup。遇到 origin_changed 且 manualActionRequired=true，表示跨源 popup 已打开但安全策略要求用户在可见 Chrome 中手动完成；不要重试 interactionDispatched=true 的原 click/type。用户确认 popup 关闭或返回原 approved origin 后，再调用 browser_snapshot。',
  '等待动态页面时，使用 browser_wait 的 visible/hidden 条件；等待 loading 或遮罩消失时用 hidden，不要只依赖固定 sleep。',
  '浏览器失败返回 ok=false 的结构化错误。retryable=true 时根据 code/details 重新 snapshot、等待或重新 open；不要盲目重复有副作用的操作。',
  '完成后返回你实际打开、操作或提取到的内容；不要声称完成未通过工具确认的页面操作。',
];

function projectBrowserRuntimeDetails(runtime: BrowserRuntime) {
  const snapshot = runtime.getSnapshot();
  return {
    extension: {
      ...snapshot.extension,
      capabilities: [...snapshot.extension.capabilities],
    },
    readiness: snapshot.readiness
      ? {
          phase: snapshot.readiness.phase,
          ready: snapshot.readiness.ready,
          ...(snapshot.readiness.error
            ? { error: { ...snapshot.readiness.error } }
            : {}),
        }
      : null,
  };
}

export type BrowserToolkitOptions = {
  /** Extension bridge transport; defaults to the per-user bridge socket. */
  bridge?: BrowserExtensionBridge;
};

export function createBrowserToolkit(options: BrowserToolkitOptions = {}): AgentToolkit {
  // One Toolkit definition may be started by independent Host managers. Each
  // manager owns its BrowserRuntime root; roots share only the provider-level
  // bridge transport through Browser's internal lease coordinator.
  const bridge = options.bridge ?? new BrowserExtensionBridge();

  const reviews: Record<string, ToolReviewPolicy> = {
    browser_open: ReviewPolicies.externalAccess({ authorization: 'url_origin' }),
  };
  const toolkit = defineToolkit({
    name: BROWSER_TOOLKIT_NAME,
    description: '浏览器网页访问、登录态复用、JS 渲染页面读取、点击输入等待和页面内容提取。',
    tools: browserTools.map((toolItem) => ({
      tool: toolItem,
      operation: browserOperationMetadata[toolItem.name],
      review: reviews[toolItem.name],
      ...(toolItem.name === 'browser_screenshot'
        ? { requiresInputModalities: ['image'] as const }
        : {}),
    })),
    runtime: {
      start: async () => {
        const root = new BrowserRuntime({ bridge });
        await root.start();
        return root;
      },
      diagnose: (root) => projectBrowserRuntimeDetails(root as BrowserRuntime),
      stop: async (root) => await (root as BrowserRuntime).stop(),
    },
    instructions: browserToolkitInstructions.join('\n'),
  });

  return toolkit;
}
