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
  '查看状态、diff、历史和提交内容用 inspect_shell 运行 git 命令。其他 git 写操作（切换分支、stash、pull、rebase、reset、强推等）用 run_shell，会走审批；确是任务需要时再做，先确认影响范围，能保留数据时优先用可恢复的做法。',
];

/** Everyday git writes (add, commit, push) through ShellRS. */
export function createGitToolkit(deps: ShellToolkitDependencies): AgentToolkit {
  return defineToolkit({
    name: GIT_TOOLKIT_NAME,
    description: '暂存、提交和普通推送本地 git 仓库，不需要审批；其他 git 操作通过 shell。',
    // The schemas exclude dangerous forms (no implicit `git add .`, no force
    // push or ref deletion), so these run unreviewed.
    tools: executionScopedDefinitions(createGitTools(deps.shell), gitOperationMetadata, {}),
    instructions: gitToolkitInstructions.join('\n'),
    requires: shellRequirement,
    availability: shellAvailability(deps.shell),
  });
}
