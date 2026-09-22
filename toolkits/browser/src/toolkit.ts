import { defineToolkit, ReviewPolicies, type AgentToolkit, type ToolReviewPolicy } from '@pinpawo/pet-agent';
import { BROWSER_TOOLKIT_NAME } from './constants';
import { browserTools } from './tools';
import { browserOperationMetadata } from './operationMetadata';

export { BROWSER_TOOLKIT_NAME } from './constants';

const browserToolkitInstructions = [
  '你负责需要真实浏览器参与的网页访问、页面交互、登录态复用、JS 渲染内容读取和页面内容提取。',
  '优先使用 browser_open 打开目标页面，再根据页面状态使用 browser_snapshot、browser_click、browser_type、browser_scroll、browser_wait、browser_extract 或 browser_screenshot。',
  'browser_open 永远使用 default session；不要根据 URL、网站名、域名、平台名或任务名创建特殊 session。',
  '只有用户明确要求隔离登录状态、复用某个专属浏览器会话，或直接给出会话名称时，才使用 browser_open_with_session。',
  '如果用户明确提供了本机浏览器 profile 或 user-data-dir 路径，使用 browser_open_with_profile；不要把本机 profile 路径填到 browser_open 的 session 参数里。',
  '浏览器会话名称不是本机 Chrome profile 名；本机 Chrome user-data-dir 只能走 browser_open_with_profile。',
  '需要登录、验证码或用户手动操作时保持可见浏览器窗口；纯读取或抓取时可以使用 headless。',
  '使用 snapshot 返回的 ref 进行 click/type/wait；ref 在页面变化或下一次 snapshot 后失效，遇到 stale reference 时重新 snapshot。',
  'Browser 使用 CDP。已连接浏览器不能改变 profile/headless；启动参数必须符合 Runtime 配置，不能切换 backend。命名 session 的独立登录态在当前 Host 连接内保留。',
  'browser_open、browser_snapshot、点击、输入和等待返回的是页面预览；如果结果里的 truncated 或 hasMore 为 true，说明模型只看到了片段。',
  '页面需要视觉判断时使用 browser_screenshot；截图会直接作为图片给到你，看完就基于结论继续操作。',
  '长文章、Gist、文档、GitHub 页面或搜索结果页在总结、引用、判断前，必须用 browser_extract({ offset, limit }) 按 nextOffset 分块读取，直到 hasMore 为 false。',
  'browser_extract 不给 selector 时会读取当前页面正文全文分块；不要为了绕过截断而从不完整 snapshot 里猜 selector。',
  '点击或提交打开 popup/新标签页时，browser capability 会跟随新目标；新目标关闭后会尽量回到上一目标。',
  '只允许继续读取和操作 approved origin 的页面与 popup。遇到 origin_changed 且 manualActionRequired=true，表示跨源 popup 已打开但安全策略要求用户在可见 Chrome 中手动完成；不要重试 interactionDispatched=true 的原 click/type。用户确认 popup 关闭或返回原 approved origin 后，再调用 browser_snapshot。',
  '等待动态页面时，使用 browser_wait 的 visible/hidden 条件；等待 loading 或遮罩消失时用 hidden，不要只依赖固定 sleep。',
  '浏览器失败返回 ok=false 的结构化错误。retryable=true 时根据 code/details 重新 snapshot、等待或重新 open；不要盲目重复有副作用的操作。',
  '完成后返回你实际打开、操作或提取到的内容；不要声称完成未通过工具确认的页面操作。',
];

export function createBrowserToolkit(): AgentToolkit {
  const reviews: Record<string, ToolReviewPolicy> = {
    browser_open: ReviewPolicies.externalAccess({ authorization: 'url_origin' }),
    browser_open_with_session: ReviewPolicies.externalAccess({ authorization: 'exact' }),
    browser_open_with_profile: ReviewPolicies.externalAccess({ authorization: 'exact' }),
  };
  return defineToolkit({
    name: BROWSER_TOOLKIT_NAME,
    description: '通过 CDP 访问浏览器、读取渲染页面、点击输入、提取文本和截图。',
    tools: browserTools.map((item) => ({
      tool: item,
      operation: browserOperationMetadata[item.name],
      review: reviews[item.name],
      ...(item.name === 'browser_screenshot' ? { requiresInputModalities: ['image'] as const } : {}),
    })),
    instructions: browserToolkitInstructions.join('\n'),
  });
}
