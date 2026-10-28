import { defineToolkit, type AgentToolkit } from '@pinpawo/pet-agent';
import {
  executionScopedDefinitions,
  shellAvailability,
  shellRequirement,
  type ShellToolkitDependencies,
} from '../toolDefinitions';
import { createGithubTools, githubOperationMetadata } from './githubTools';

export const GITHUB_TOOLKIT_NAME = 'github';

const githubToolkitInstructions = [
  '创建 PR 用 gh_pr_create，创建 issue 用 gh_issue_create：标题和正文作为结构化参数传入，不需要在命令行里转义长正文。两者直接执行，不需要审批。',
];

/** GitHub PR and issue creation through the gh CLI on ShellRS. */
export function createGithubToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  return defineToolkit({
    name: GITHUB_TOOLKIT_NAME,
    description: '创建 GitHub PR 和 issue，不需要审批。',
    tools: executionScopedDefinitions(createGithubTools(deps.shell).githubTools, githubOperationMetadata, {}),
    instructions: githubToolkitInstructions.join('\n'),
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
