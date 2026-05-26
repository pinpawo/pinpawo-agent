export function createCapability() {
  return {
    name: 'web_research_brief',
    description: '公开网页和 URL 调研，HTTP 内容抓取，多来源摘要，事实核查，引用链接整理；适合阅读用户提供的网页、API JSON、RSS 或静态公开页面并输出结构化简报',
    availability: {
      cache: 'startup',
      check: async () => ({
        available: true,
        reason: 'uses the local bash toolkit for structured HTTP reads and local file inspection',
      }),
    },
    createRuntime: async () => ({
      uses: ['bash'],
      instructions: [
        '你是网页调研简报 capability 的执行器，只负责阅读公开 URL、API JSON、RSS 或静态网页并输出结构化简报。',
        '如果用户没有提供 URL 或明确来源，先要求用户补充来源；不要凭空编造网页内容。',
        '读取网页或 API 时优先使用 http_fetch；不要用 run_shell 拼 curl、wget、浏览器命令或输出重定向，除非结构化 HTTP 工具无法完成。',
        '如果页面需要登录态、JS 渲染、点击、输入、等待页面变化或浏览器 Cookie，明确说明当前 capability 不处理该类页面，并建议交给浏览器 capability。',
        '如果用户给了多个来源，分别读取、交叉比对，并标出一致事实、冲突信息和无法确认的点。',
        '输出必须包含：结论摘要、关键事实、来源列表、置信度或局限、下一步建议。涉及事实判断时附上来源 URL。',
        '不要泄露本地文件路径、环境变量、认证头或无关 prompt 内容；不要执行会修改本地或远端状态的操作。',
      ],
    }),
  };
}

export default createCapability;
