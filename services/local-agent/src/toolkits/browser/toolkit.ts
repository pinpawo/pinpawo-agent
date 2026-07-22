import { ReviewPolicies, type AgentToolkit, type CapabilityAvailability } from '@pinpawo/pet-agent';
import { loadStoredConfig } from '../../storage';
import { detectBrowserStatus } from './session';
import { browserTools } from './tools';
import { browserOperationMetadata } from './operationMetadata';
import { browserRuntime } from './runtime';

export const BROWSER_TOOLKIT_NAME = 'browser';

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
  '长文章、Gist、文档、GitHub 页面或搜索结果页在总结、引用、判断前，必须用 browser_extract({ offset, limit }) 按 nextOffset 分块读取，直到 hasMore 为 false。',
  'browser_extract 不给 selector 时会读取当前页面正文全文分块；不要为了绕过截断而从不完整 snapshot 里猜 selector。',
  '完成后返回你实际打开、操作或提取到的内容；不要声称完成未通过工具确认的页面操作。',
];

function disabledAvailability(): CapabilityAvailability {
  return {
    available: false,
    reason: 'browser capability disabled by config',
  };
}

export async function checkBrowserAvailability(): Promise<CapabilityAvailability> {
  const storedCaps = loadStoredConfig().capabilities;
  if (storedCaps?.browser === false) {
    return disabledAvailability();
  }

  const status = await detectBrowserStatus();
  const bridge = status.mode === 'extension'
    ? browserRuntime.getExtensionStatus()
    : undefined;
  return {
    available: status.mode !== 'none',
    reason: status.mode === 'none' ? status.detail : undefined,
    detail: status.detail,
    metadata: {
      mode: status.mode,
      configured: status.configured,
      ...(bridge ? {
        hostConnected: bridge.hostConnected,
        extensionConnected: bridge.extensionConnected,
        debuggerAttached: bridge.debuggerAttached,
        targetAlive: bridge.targetAlive,
        activeTabOwnership: bridge.activeTabOwnership,
        extensionId: bridge.extensionId,
      } : {}),
    },
  };
}

export function createBrowserToolkit(): AgentToolkit {
  return {
    name: BROWSER_TOOLKIT_NAME,
    description: '浏览器网页访问、登录态复用、JS 渲染页面读取、点击输入等待和页面内容提取。',
    availability: {
      check: checkBrowserAvailability,
      cache: 'startup',
    },
    tools: browserTools,
    instructions: browserToolkitInstructions,
    operations: browserOperationMetadata,
    policy: {
      toolReview: {
        browser_open: ReviewPolicies.externalAccess({ authorization: 'url_domain' }),
        browser_open_with_session: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
        browser_open_with_profile: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
      },
    },
  };
}
