import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReadOnlyShellCommand as classify } from './readOnlyShell';

test('ordinary inspection and git/gh reads stay exempt, including sink redirections', () => {
  for (const command of ['ls -la', 'cat file | jq ".events | map(.type)"',
    'cd /repo && rg -n foo | head -20', 'cd /repo\nrg -n foo', 'find . -name "*.ts"',
    'sed -n 1,20p file', 'git status', 'git log --oneline | head', 'git diff --stat',
    'git remote -v 2>&1', 'git branch -a >/dev/null 2>&1', 'git tag &>/dev/null',
    'git stash list 2>&-', 'gh pr checks 12 2>&1 | head', 'git show <&3',
    'gh api repos/o/r/pulls | jq length', "jq --arg name value '$name' file", 'echo ok # ; rm file']) {
    assert.equal(classify(command).allowed, true, command);
  }
});

test('unknown commands, executable forms and writes defer to reviewed execution', () => {
  for (const command of ['custom-inspector --status', 'python3 -c "print(1)"', 'make -n build',
    'npm run build', 'bash -c "ls"', 'env FOO=1 ls', '/tmp/ls', '$COMMAND',
    'echo $(touch x)', 'echo `touch x`', 'find . -exec cat {} \\;', 'find . -delete',
    'find . | xargs wc', 'rg --pre=evil foo', 'sort -o out file', 'sort --compress-program evil',
    "sed -n '1e touch x' file", 'jq -f script.jq file', 'git reset --hard', 'gh pr merge 1 --squash',
    'git branch 2 >/dev/null', 'cat <>file', 'echo hi >file', 'ls # comment\nrm file',
    'uniq input output', 'uniq -- -input output', 'git diff --ext-diff', 'git grep -Ocat pattern',
    'git reflog write refs/heads/main old new message', "echo ok # '\necho `touch marker`",
    'ls &', 'ls >', 'if test -f file; then cat file; fi', '']) {
    assert.equal(classify(command).allowed, false, command);
  }
});
