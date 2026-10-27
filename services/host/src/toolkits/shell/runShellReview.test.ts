import assert from 'node:assert/strict';
import test from 'node:test';
import { runShellCommandNeedsReview as needsReview } from './runShellReview';

test('plain git and gh reads and everyday writes run without review', () => {
  for (const command of ['git status --short', 'git add src/a.ts && git commit -m "fix: x"', 'git push -u origin HEAD',
    'cd /repo && git pull', 'git fetch; git rebase origin/main', 'gh pr comment 12 --body LGTM',
    'gh pr create --title t --body "long body"', 'gh pr checks 12 || gh run list']) {
    assert.equal(needsReview(command), false, command);
  }
});

test('risky git/gh forms, other programs and anything the check does not follow are reviewed', () => {
  for (const command of ['git reset --hard HEAD', 'git clean -fd', 'git push --force origin HEAD', 'gh pr merge 1 --squash',
    'gh api -X DELETE repos/o/r', 'git add . && rm -rf build', 'npm test', 'ls', 'cd /repo',
    'git log | head', 'git diff > out.patch', 'git commit -m "$(cat msg)"', 'git commit -m `x`', 'git add *.ts',
    'GIT_DIR=x git status', 'git status &', 'git status # note', 'git status\nrm x', 'git my-alias', '', '  ',
    'git checkout file', 'git checkout HEAD file', 'git push origin -- :refs/heads/main',
    'git push origin -- +HEAD:refs/heads/main', 'gh pr checkout 1 --force']) {
    assert.equal(needsReview(command), true, command);
  }
});
