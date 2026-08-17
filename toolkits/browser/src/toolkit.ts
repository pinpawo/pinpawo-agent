import {
  defineToolkit,
  ReviewPolicies,
  type AgentCapability,
  type AgentToolkit,
  type ToolReviewPolicy,
} from '@pinpawo/pet-agent';
import { createBrowserCapability } from './capability';
import { BROWSER_TOOLKIT_NAME } from './constants';
import {
  detectBrowserEnvironment,
  detectBrowserStatus,
  type BrowserEnvironment,
  type BrowserStatus,
} from './session';
import { browserTools } from './tools';
import { browserOperationMetadata } from './operationMetadata';
import { BrowserRuntime } from './runtime';
import { BrowserExtensionBridge } from './drivers/chromeExtension/bridge';
import {
  resolveBrowserToolkitOptions,
  type BrowserToolkitOptions,
} from './options';

export { BROWSER_TOOLKIT_NAME } from './constants';

export type BrowserAvailabilitySnapshot = {
  available: boolean;
  reason?: string;
  detail?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type BrowserIntegration = {
  toolkit: AgentToolkit;
  capability: AgentCapability;
  runtime: BrowserRuntime;
  checkAvailability: () => Promise<BrowserAvailabilitySnapshot>;
  getCachedAvailability: () => BrowserAvailabilitySnapshot | null;
  detectEnvironment: () => Promise<BrowserEnvironment>;
};

const browserToolkitInstructions = [
  '你负责需要真实浏览器参与的网页访问、页面交互、登录态复用、JS 渲染内容读取和页面内容提取。',
  '优先使用 browser_open 打开目标页面，再根据页面状态使用 browser_snapshot、browser_click、browser_type、browser_scroll、browser_wait、browser_extract 或 browser_screenshot。',
  'browser_open 永远使用 default session；不要根据 URL、网站名、域名、平台名或任务名创建特殊 session。',
  '只有用户明确要求隔离登录状态、复用某个专属浏览器会话，或直接给出会话名称时，才使用 browser_open_with_session。',
  '如果用户明确提供了本机浏览器 profile 或 user-data-dir 路径，使用 browser_open_with_profile；不要把本机 profile 路径填到 browser_open 的 session 参数里。',
  '浏览器会话名称不是本机 Chrome profile 名；本机 Chrome user-data-dir 只能走 browser_open_with_profile。',
  '需要登录、验证码或用户手动操作时保持可见浏览器窗口；纯读取或抓取时可以使用 headless。',
  '当 PINPAWO_BROWSER_BACKEND=extension 时，使用 snapshot 返回的 ref 进行 click/type/wait 最稳定；ref 在下一次页面变化或 snapshot 后可能失效，遇到 stale reference 时重新 snapshot。命名 session、profile 和 headless 对 extension 后端仍不适用。',
  'browser_open、browser_snapshot、点击、输入和等待返回的是页面预览；如果结果里的 truncated 或 hasMore 为 true，说明模型只看到了片段。',
  '页面需要视觉判断时使用 browser_screenshot；截图会直接作为图片给到你，看完就基于结论继续操作。',
  '长文章、Gist、文档、GitHub 页面或搜索结果页在总结、引用、判断前，必须用 browser_extract({ offset, limit }) 按 nextOffset 分块读取，直到 hasMore 为 false。',
  'browser_extract 不给 selector 时会读取当前页面正文全文分块；不要为了绕过截断而从不完整 snapshot 里猜 selector。',
  '点击或提交打开 popup/新标签页时，browser capability 会跟随新目标；新目标关闭后会尽量回到上一目标。',
  'extension 后端只允许继续读取和操作同源 popup。遇到 origin_changed 且 manualActionRequired=true，表示跨源 popup 已打开但安全策略要求用户在可见 Chrome 中手动完成；不要重试 interactionDispatched=true 的原 click/type。用户确认 popup 关闭或返回原 approved origin 后，再调用 browser_snapshot。',
  '等待动态页面时，使用 browser_wait 的 visible/hidden 条件；等待 loading 或遮罩消失时用 hidden，不要只依赖固定 sleep。',
  '浏览器失败返回 ok=false 的结构化错误。retryable=true 时根据 code/details 重新 snapshot、等待或重新 open；不要盲目重复有副作用的操作。',
  '完成后返回你实际打开、操作或提取到的内容；不要声称完成未通过工具确认的页面操作。',
];

function disabledAvailability(): BrowserAvailabilitySnapshot {
  return {
    available: false,
    reason: 'browser Toolkit disabled by host config',
  };
}

export function buildBrowserAvailabilitySnapshot(
  status: BrowserStatus,
): BrowserAvailabilitySnapshot {
  // Toolkit availability is cached and filters the runtime registry. Keep a
  // waiting extension routable so a later reconnect can recover without
  // rebuilding the agent; commandReady is the live execution signal.
  const available = status.mode !== 'none';
  return {
    available,
    reason: available ? undefined : status.detail,
    detail: status.detail,
    metadata: {
      mode: status.mode,
      configured: status.configured,
      commandReady: status.commandReady,
    },
  };
}

export function createBrowserIntegration(
  browserOptions: BrowserToolkitOptions = {},
): BrowserIntegration {
  const options = resolveBrowserToolkitOptions(browserOptions);
  // Availability may be queried before a Host starts Runtime roots. The
  // fallback never acquires resources; every ToolkitRuntimeManager start gets
  // its own BrowserRuntime root instead of sharing this integration object.
  // Roots share only the process-level extension bridge transport: their
  // thread/session/workdir state and shutdown remain isolated.
  const bridge = new BrowserExtensionBridge();
  const availabilityRuntime = new BrowserRuntime(options, { bridge });
  const runtimeRoots: BrowserRuntime[] = [];
  const currentRuntime = () => runtimeRoots.at(-1) ?? availabilityRuntime;
  let latestAvailability: BrowserAvailabilitySnapshot | null = null;

  const rememberAvailability = (
    availability: BrowserAvailabilitySnapshot,
  ): BrowserAvailabilitySnapshot => {
    latestAvailability = availability;
    return availability;
  };

  const checkAvailability = async (): Promise<BrowserAvailabilitySnapshot> => {
    if (!options.enabled()) {
      return rememberAvailability(disabledAvailability());
    }

    try {
      const status = await detectBrowserStatus(
        currentRuntime().getSnapshot(),
        options,
      );
      return rememberAvailability(buildBrowserAvailabilitySnapshot(status));
    } catch (error) {
      return rememberAvailability({
        available: false,
        reason: error instanceof Error
          ? error.message
          : 'browser availability check failed',
      });
    }
  };

  const reviews: Record<string, ToolReviewPolicy> = {
    browser_open: ReviewPolicies.externalAccess({ authorization: 'url_origin' }),
    browser_open_with_session: ReviewPolicies.externalAccess({ authorization: 'exact' }),
    browser_open_with_profile: ReviewPolicies.externalAccess({ authorization: 'exact' }),
  };
  const toolkit = defineToolkit({
    name: BROWSER_TOOLKIT_NAME,
    description: '浏览器网页访问、登录态复用、JS 渲染页面读取、点击输入等待和页面内容提取。',
    availability: async () => {
      const availability = await checkAvailability();
      return availability.available
        ? { available: true }
        : {
            available: false,
            reason: availability.reason ?? 'browser toolkit unavailable',
          };
    },
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
        const root = new BrowserRuntime(options, { bridge });
        await root.start();
        runtimeRoots.push(root);
        return root;
      },
      stop: async (root) => {
        const runtimeRoot = root as BrowserRuntime;
        try {
          await runtimeRoot.stop();
        } finally {
          const index = runtimeRoots.lastIndexOf(runtimeRoot);
          if (index >= 0) runtimeRoots.splice(index, 1);
        }
      },
    },
    instructions: browserToolkitInstructions.join('\n'),
  });

  return {
    toolkit,
    capability: createBrowserCapability(),
    get runtime() {
      return currentRuntime();
    },
    checkAvailability,
    getCachedAvailability: () => latestAvailability,
    detectEnvironment: () => detectBrowserEnvironment(options),
  };
}

export function createBrowserToolkit(options: BrowserToolkitOptions = {}): AgentToolkit {
  return createBrowserIntegration(options).toolkit;
}
