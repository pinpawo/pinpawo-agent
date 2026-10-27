import { defineToolkit, type AgentToolkit } from '@pinpawo/pet-agent';
import {
  executionScopedDefinitions,
  shellAvailability,
  shellRequirement,
  type ShellToolkitDependencies,
} from '../toolDefinitions';
import { createGitTools, gitOperationMetadata } from './gitTools';

export const GIT_TOOLKIT_NAME = 'git';

const gitToolkitInstructions = [
  '暂存、提交和普通推送用 git_add、git_commit、git_push，三者直接执行，不需要审批。',
  'git_add 必须显式传 pathspecs，不要隐式暂存整个仓库。git_commit 只创建本地提交，需要推送时继续用 git_push。git_push 不支持强推或删除远端引用。',
];

/** Everyday git writes (add, commit, push) through ShellRS. */
export function createGitToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  return defineToolkit({
    name: GIT_TOOLKIT_NAME,
    description: '暂存、提交和普通推送本地 git 仓库，不需要审批。',
    // The schemas exclude dangerous forms (no implicit `git add .`, no force
    // push or ref deletion), so these run unreviewed.
    tools: executionScopedDefinitions(createGitTools(deps.shell), gitOperationMetadata, {}),
    instructions: gitToolkitInstructions.join('\n'),
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
