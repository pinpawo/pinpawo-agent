import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  defineCapability,
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';

const DEFAULT_EXPLORE_TOOLKITS = [
  'bash',
  'git',
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
] as const;

export type ExploreCapabilityOptions = {
  uses?: readonly string[];
};

export function createExploreCapability(options: ExploreCapabilityOptions = {}): AgentCapability {
  return defineCapability({
    name: 'explore',
    description: [
      '通用探索、调查、资料检索和代码库理解 capability。',
      '适合大量阅读、搜索、检查上下文、梳理证据、先探索再决定下一步的任务。',
      '代码 review、代码审查、PR review、pull request review、diff 审查和仓库变更评审也走这个 capability，即使请求里包含 GitHub URL 或网页链接。',
      '只做只读调查和总结，不修改文件、不执行外部真实副作用。',
    ].join(' '),
    uses: options.uses ?? DEFAULT_EXPLORE_TOOLKITS,
    instructions: defineInstructionDocument({
      content: `# Explore

## 目标

只读取、检查、搜索、观察和总结上下文。

## 工作流程

使用可用工具在执行过程中自行规划探索。优先确认候选范围，再读取详细
内容；避免无界浏览或无目的扫描。

代码 review、PR review、pull request review、diff 审查和仓库变更评审
必须优先使用 git Toolkit，尤其是 \`gh_pr_view\`、\`gh_pr_diff\`、
\`git_diff\`、\`git_show\`；不要使用 browser、\`http_fetch\` 或
\`download_file\` 拉取 GitHub PR 页面、diff 或评论。

## 约束与边界

不要修改文件，不要提交、推送、删除、写入、发送消息、发布内容，或执行
任何外部真实副作用。

重要发现必须保留精确来源。运行时可能把较早执行上下文总结为摘要，需要
细节时用 \`view_file\` 等工具按来源回查。

## 输出要求

结论必须包含简洁探索摘要、已查看文件列表、关键发现、证据引用（文件路径、
URL、issue / PR 编号或命令输出来源）和建议下一步。`,
    }),
  });
}
