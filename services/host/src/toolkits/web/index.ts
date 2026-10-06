import {
  AuthorizationPolicies,
  defineToolkit,
  ReviewPolicies,
  type AgentToolkit,
} from '@pinpawo/pet-agent';
import { executionScopedDefinitions } from '../toolDefinitions';
import {
  downloadFileTool,
  httpFetchTool,
  networkOperationMetadata,
  normalizeHttpFetchAuthorizationInput,
} from './networkTools';

export const WEB_TOOLKIT_NAME = 'web';

const webToolkitInstructions = [
  '联网取内容优先用 http_fetch：静态页面、REST API、RSS、天气或汇率这类公开接口一次请求即可拿到结果，不要为此逐步驱动浏览器。只有确实需要登录态、页面交互或 JS 动态渲染时才用浏览器。同一站点首次获批后，后续同源同方法的请求不再重复审批。',
  '需要把文件保存到本地时用 download_file。',
];

/** HTTP access. Runs in the Host process, so it needs no RS and is always available. */
export function createWebToolkit(): AgentToolkit {
  return defineToolkit({
    name: WEB_TOOLKIT_NAME,
    description: '通过 HTTP 获取网页、API 内容和下载文件。',
    tools: executionScopedDefinitions([httpFetchTool, downloadFileTool], networkOperationMetadata, {
      http_fetch: ReviewPolicies.required({
        authorization: AuthorizationPolicies.exact({
          // Same origin and method stay within the approved scope.
          reuseAutoReview: true,
          subject: ({ input }) => normalizeHttpFetchAuthorizationInput(input),
        }),
      }),
      download_file: ReviewPolicies.required({ authorization: 'exact' }),
    }),
    instructions: webToolkitInstructions.join('\n'),
  });
}
