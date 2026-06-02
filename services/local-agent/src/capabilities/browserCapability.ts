import type { AgentCapability, AgentToolkit, CapabilityAvailability } from '@pinpawo/pet-agent';
import { loadStoredConfig } from '../storage';
import { detectBrowserStatus } from '../plugins/browserSession';
import { browserTools } from '../plugins/browserTools';
import { browserToolOperations } from '../plugins/browserToolOperations';

const BROWSER_TOOLKIT_NAME = 'browser';

const browserToolkitInstructions = [
  '你负责需要真实浏览器参与的网页访问、页面交互、登录态复用、JS 渲染内容读取和页面内容提取。',
  '优先使用 browser_open 打开目标页面，再根据页面状态使用 browser_snapshot、browser_click、browser_type、browser_wait 或 browser_extract。',
  'browser_open 永远使用 default session；不要根据 URL、网站名、域名、平台名或任务名创建特殊 session。',
  '只有用户明确要求隔离登录状态、复用某个专属浏览器会话，或直接给出会话名称时，才使用 browser_open_with_session。',
  '如果用户明确提供了本机浏览器 profile 或 user-data-dir 路径，使用 browser_open_with_profile；不要把本机 profile 路径填到 browser_open 的 session 参数里。',
  '浏览器会话名称不是本机 Chrome profile 名；本机 Chrome user-data-dir 只能走 browser_open_with_profile。',
  '需要登录、验证码或用户手动操作时保持可见浏览器窗口；纯读取或抓取时可以使用 headless。',
  '完成后返回你实际打开、操作或提取到的内容；不要声称完成未通过工具确认的页面操作。',
];

function disabledAvailability(): CapabilityAvailability {
  return {
    available: false,
    reason: 'browser capability disabled by config',
  };
}

async function checkBrowserAvailability(): Promise<CapabilityAvailability> {
  const storedCaps = loadStoredConfig().capabilities;
  if (storedCaps?.browser === false) {
    return disabledAvailability();
  }

  const status = await detectBrowserStatus();
  return {
    available: status.mode !== 'none',
    reason: status.mode === 'none' ? status.detail : undefined,
    detail: status.detail,
    metadata: {
      mode: status.mode,
      configured: status.configured,
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
    operations: browserToolOperations,
  };
}

export function createBrowserCapability(): AgentCapability {
  return {
    name: 'browser',
    description: '使用本机浏览器/Chrome/browser 打开 URL、链接、网站和网页，复用登录态，处理 JS 渲染、验证码或手动登录，点击、输入、等待页面变化并提取页面内容。',
    availability: {
      check: checkBrowserAvailability,
      cache: 'startup',
    },
    createRuntime: () => ({
      uses: [BROWSER_TOOLKIT_NAME],
      instructions: [
        '你是浏览器任务执行器；当前任务已经明确需要浏览器能力，不要重新做路由判断。',
      ],
    }),
  };
}
