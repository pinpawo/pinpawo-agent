import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'shell-quote';
import { classifyGhArgs, classifyGitArgs, type VcsLevel, type VcsVerdict } from './vcsCommands';

const argv = (command: string) => parse(command) as string[];

function expectLevel(classify: (args: string[]) => VcsVerdict, program: string, level: VcsLevel, commands: string[]) {
  for (const command of commands) {
    assert.equal(classify(argv(command)).level, level, `${program} ${command}`);
  }
}

test('git reads run anywhere without review', () => {
  expectLevel(classifyGitArgs, 'git', 'read', [
    'status --short', 'log --oneline -20 -- src', 'diff --stat main...HEAD', 'show HEAD:package.json',
    'blame -L 1,20 src/index.ts', 'rev-parse --abbrev-ref HEAD', 'merge-base main HEAD',
    'ls-files', 'grep -n foo', 'check-ignore -v file', 'ls-remote origin', 'for-each-ref refs/heads',
    '--no-pager log -1', '-C /repo status', '--git-dir=/repo/.git log',
    'branch', 'branch -a -vv', 'branch --show-current', 'branch --list "feat/*"',
    'branch --contains HEAD', 'branch --sort=-committerdate', 'branch -r --merged main',
    'tag', 'tag -l "v*"', 'tag --contains HEAD', 'tag -n5',
    'stash list', 'stash show -p stash@{0}', 'remote -v', 'remote get-url origin',
    'config --get user.name', 'config --list', 'config get user.email',
    'worktree list', 'reflog', 'reflog show main -n 5', 'submodule status', '--version',
  ]);
});

test('everyday git writes are changes that run without review', () => {
  expectLevel(classifyGitArgs, 'git', 'change', [
    'add .', 'commit -m x', 'checkout main', 'checkout -b feat', 'switch -c x', 'restore --staged file',
    'reset --soft HEAD~1', 'reset HEAD file', 'clean -nd', 'stash', 'stash pop', 'fetch --prune', 'pull',
    'merge main', 'rebase main', 'cherry-pick abc', 'revert abc', 'push', 'push -u origin HEAD',
    'branch new-branch', 'branch -d old', 'branch -m a b', 'tag v1.0', 'tag -a v1 -m msg',
    'remote add o url', 'config user.name x', 'worktree add ../x', 'rm --cached file', 'gc',
    'log --output=out.txt',
  ]);
});

test('git forms that lose work, rewrite shared history or run programs are risky', () => {
  expectLevel(classifyGitArgs, 'git', 'risky', [
    'reset --hard HEAD', 'clean -fd', 'checkout -- file', 'checkout .', 'checkout -f main',
    'switch --discard-changes main', 'restore file', 'restore --staged --worktree file',
    'stash drop', 'stash clear', 'branch -D old', 'branch -f main HEAD~1', 'tag -d v1.0',
    'push --force origin HEAD', 'push -f', 'push --force-with-lease', 'push --delete origin x',
    'push origin :x', 'push origin +HEAD:main', 'rm -f file', 'reflog expire --all',
    'gc --prune=now', 'update-ref -d refs/heads/x', 'worktree remove --force ../x',
    '-c core.pager=sh status', '--exec-path=/tmp log', 'my-alias', 'filter-branch', '',
  ]);
});

test('gh reads run anywhere without review', () => {
  expectLevel(classifyGhArgs, 'gh', 'read', [
    'pr list', 'pr view 123 --comments', 'pr diff 123', 'pr checks 123', 'pr status',
    'issue list --label bug', 'issue view 5', 'run list -w ci.yml', 'run view 1 --log-failed',
    'workflow list', 'release view v1', 'repo view owner/repo', 'search prs is:open',
    'label list', 'auth status', 'status', '--version',
    'api repos/o/r/pulls', 'api -X GET repos/o/r', 'api --method=get repos/o/r --paginate',
    'api -H "Accept: application/json" repos/o/r/issues',
  ]);
});

test('everyday GitHub collaboration runs without review', () => {
  expectLevel(classifyGhArgs, 'gh', 'change', [
    'pr create', 'pr comment 1 --body x', 'pr review 1 --approve', 'pr edit 1 --add-label x',
    'pr close 1', 'pr reopen 1', 'pr ready 1', 'pr checkout 1', 'issue create', 'issue comment 1 -b x',
    'issue close 1', 'label create x', 'run rerun 1', 'run cancel 1', 'workflow run ci.yml',
    'repo clone o/r', 'pr view 1 --web', 'issue list -w',
  ]);
});

test('gh operations on shared state, credentials or unknown effects are risky', () => {
  expectLevel(classifyGhArgs, 'gh', 'risky', [
    'pr merge 1 --squash', 'repo delete o/r', 'repo edit --visibility public', 'release create v1',
    'release delete v1', 'secret set X', 'variable delete X', 'label delete x', 'issue delete 1',
    'issue transfer 1 o/other', 'run delete 1', 'auth token', 'auth login', 'auth status --show-token',
    'extension install x', 'alias set co "pr checkout"', 'browse',
    'api -X POST repos/o/r/issues', 'api -XDELETE repos/o/r', 'api --method PATCH repos/o/r',
    'api repos/o/r/issues -f title=x', 'api graphql -F query=@q.graphql', 'api repos/o/r --input body.json',
    '',
  ]);
});
