import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReadOnlyShellCommand as classify } from './readOnlyShell';

function allows(command: string, expected = true) {
  const result = classify(command);
  assert.equal(result.allowed, expected, `${command}: ${JSON.stringify(result)}`);
}

function redirects(command: string, tool: RegExp) {
  const result = classify(command);
  assert.equal(result.allowed, false, command);
  assert.match(result.allowed ? '' : result.redirect, tool, command);
}

test('inspection commands outside the blocklist are trusted, quoted operators included', () => {
  for (const command of [
    'ls -la', 'nc -vz example.com 443', 'ossutil ls oss://pinet/ 2>&1 | head',
    'custom-inspector --status', 'cat file | jq ".events | map(.type)"', "jq '.events\n| map(.type)' file",
    "echo 'rm file | sudo ls; kill -9 1'", 'echo "rm | kill"', 'echo ok # ; rm file',
    'cd /repo && rg -n "foo" | head -20', 'cd /repo\nrg -n foo', 'find . -name "*.ts" | xargs wc -l',
    'find . -name "*.ts" -exec grep -l foo {} \\;', 'rm --help', 'command -v rm',
    'kill -0 123', 'kill -l', 'pkill -0 node', 'if test -f file; then cat file; else ls; fi',
    'bash -c "ls -la"', 'echo hi > file', 'npm install',
  ]) allows(command);
});

for (const separator of ['|', '&&', '||', ';', '&', '|&', '\n']) {
  test(`checks every command on both sides of ${JSON.stringify(separator)}`, () => {
    allows(`printf ok ${separator} stat file`);
    for (const dangerous of ['rm file', '/bin/rm file', 'env FOO=1 command rm file', 'kill -9 123',
      'git reset --hard', 'gh pr merge 1 --squash']) {
      allows(`printf ok ${separator} ${dangerous}`, false);
      allows(`${dangerous} ${separator} head`, false);
    }
  });
}

test('bottom-line operations are refused at direct, prefixed and wrapped heads', () => {
  for (const command of [
    'rm file', 'rm -- --help', 'shred file', 'dd if=image of=/dev/disk0', 'mkfs.ext4 /dev/sda',
    'sudo ls', 'reboot', 'FOO=1 rm file', "'r'm file", 'r\\m file', 'env -u FOO /bin/rm file',
    'exec -a label rm file', 'kill -KILL 123', 'kill -s KILL 123', 'kill --signal=9 123',
    'pkill -9 node', 'killall -KILL node',
    'if rm file; then ls; fi', 'if false; then ls; else rm file; fi',
    // a newline is a separator even though shell-quote reads it as whitespace
    'cd /repo\nrm -rf build', 'ls # comment\nrm file',
    // one level of indirection hiding the same head
    'bash -c "rm -rf build"', 'sh -lc "cd x && rm y"', 'find . -delete', 'find . -name x -exec rm {} \\;',
    'find . | xargs rm', 'xargs -0 -n 1 rm < list', 'bash -c "git reset --hard"',
  ]) allows(command, false);
  allows('', false);
});

test('git and gh writes are refused and pointed at their permissioned tools', () => {
  for (const command of ['git reset --hard', 'git -C /repo clean -fd', 'git push --force', 'git commit -m x',
    'git branch -D main', 'git stash', 'cd /repo && git checkout main']) {
    redirects(command, /git_shell/);
  }
  for (const command of ['gh pr merge 1 --squash', 'gh pr comment 1 --body x', 'gh api -X POST repos/o/r/issues']) {
    redirects(command, /gh_shell/);
  }
  redirects('rm -rf build', /run_shell/);
  for (const command of ['git status', 'git log --oneline | head', 'git diff --stat', 'git -C /repo branch -a',
    'gh pr checks 1', 'gh api repos/o/r/pulls | jq length']) {
    allows(command);
  }
});

test('variables stay placeholders instead of expanding from the Host environment', () => {
  // Erasing $PREFIX would change the first executable into rm.
  allows('$PREFIX"rm" file');
  allows('echo "$VALUE | rm file"');
  allows('echo $VALUE | rm file', false);
  allows('FOO=$VALUE rm file', false);
  // An unknown git subcommand is not read-only, so it goes to git_shell.
  allows('git $SUBCOMMAND', false);
});
