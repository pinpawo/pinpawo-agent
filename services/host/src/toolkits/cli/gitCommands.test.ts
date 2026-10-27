import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'shell-quote';
import { gitWriteReason } from './gitCommands';

const argv = (command: string) => parse(command) as string[];

function expectRead(commands: string[], read: boolean) {
  for (const command of commands) {
    assert.equal(gitWriteReason(argv(command)) === undefined, read, `git ${command}`);
  }
}

test('git reads are recognized as read-only', () => {
  expectRead([
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
    'clean -nd', 'clean --dry-run -x',
  ], true);
});

test('any git write, program-running option or unknown form is not read-only', () => {
  expectRead([
    'add .', 'commit -m x', 'checkout', 'checkout -', 'checkout -b feat', 'checkout -b feat origin/main',
    'checkout -B feat HEAD~1', 'checkout --orphan gh-pages', 'checkout --detach HEAD~1', 'checkout -q -b feat',
    'switch main', 'switch -c x', 'restore --staged file',
    'reset --soft HEAD~1', 'reset HEAD file', 'stash', 'stash pop', 'fetch --prune', 'pull',
    'merge main', 'rebase main', 'cherry-pick abc', 'revert abc', 'push', 'push -u origin HEAD',
    'branch new-branch', 'branch -d old', 'branch -m a b', 'tag v1.0', 'tag -a v1 -m msg',
    'remote add o url', 'config user.name x', 'worktree add ../x', 'rm --cached file', 'gc',
    'log --output=out.txt',
    'reset --hard HEAD', 'clean -fd', 'checkout -- file', 'checkout .', 'checkout -f main',
    'checkout file', 'checkout HEAD file', 'checkout main', 'checkout -b feat main file',
    'checkout --ours file', 'checkout -p', 'checkout --pathspec-from-file=list',
    'switch --discard-changes main', 'restore file', 'restore --staged --worktree file',
    'stash drop', 'stash clear', 'branch -D old', 'branch -f main HEAD~1', 'tag -d v1.0',
    'push --force origin HEAD', 'push -f', 'push --force-with-lease', 'push --delete origin x',
    'push origin :x', 'push origin +HEAD:main',
    'push origin -- :refs/heads/main', 'push origin -- +HEAD:refs/heads/main', 'rm -f file', 'reflog expire --all',
    'gc --prune=now', 'update-ref -d refs/heads/x', 'worktree remove --force ../x',
    '-c core.pager=sh status', '--exec-path=/tmp log', 'my-alias', 'filter-branch', '',
  ], false);
});
