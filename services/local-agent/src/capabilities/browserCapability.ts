import type { AgentCapability } from '@pinpawo/pet-agent';
import {
  BROWSER_TOOLKIT_NAME,
  checkBrowserAvailability,
} from '../toolkits/browser';

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
