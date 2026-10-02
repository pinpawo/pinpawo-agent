import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReadOnlyShellCommand } from './readOnlyShell';

/**
 * `inspect_shell` runs without review, so these cases are the safety boundary
 * itself. A command that reaches execution here reaches it unreviewed.
 */
test('read-only shell blocks explicitly dangerous operations', () => {
  const refused = [
    // outright mutation
    'rm -rf /', 'mv a b', 'cp a b', 'chmod +x f', 'kill -9 1', 'npm install',
    // mutation hidden behind an allowed head
    'cd /repo && rm -rf build', 'git log && rm -rf .', 'ls; rm -rf /',
    // writes through redirection
    'echo hi > /tmp/f', 'cat a >> b', 'cat f | tee out.txt',
    // arbitrary execution through an inline interpreter
    'bash -c "rm x"', 'sh evil.sh', 'node -e "process.exit()"',
    'python3 -c "import os"', 'eval "rm x"',
    // arbitrary execution through substitution
    'echo `whoami`', 'echo $(rm -rf /)', 'cat <(rm x)',
    // read-only heads with an executing argument
    'find . -exec rm {} \\;', 'find . -delete', 'sed -i "s/a/b/" f',
    // git subcommands that write
    'git push', 'git commit -m x', 'git checkout main', 'git reset --hard',
    // an env prefix hides the real head
    'FOO=1 rm x',
  ];
  for (const command of refused) {
    const verdict = classifyReadOnlyShellCommand(command);
    assert.equal(verdict.allowed, false, `should refuse: ${command}`);
  }
});

test('read-only shell admits the inspection commands agents actually run', () => {
  const allowed = [
    'ls -la',
    'pwd',
    'git status',
    'git log --oneline -20',
    'git diff main HEAD',
    'git rev-parse --abbrev-ref HEAD',
    'git show HEAD --stat',
    // cd prefixes and pipes are the common real shape
    'cd /repo && grep -rn "foo" src',
    'cd /repo && git log --oneline | head -20',
    'cat package.json | jq .name',
    'find . -name "*.ts" | head',
    'echo "=== section ===" && sed -n "1,40p" file.ts',
    'wc -l src/index.ts',
  ];
  for (const command of allowed) {
    const verdict = classifyReadOnlyShellCommand(command);
    assert.equal(
      verdict.allowed,
      true,
      `should admit: ${command}${verdict.allowed ? '' : ` (${verdict.reason})`}`,
    );
  }
});

test('read-only shell explains a refusal so the agent can retry correctly', () => {
  const verdict = classifyReadOnlyShellCommand('cd /repo && rm -rf build');
  assert.equal(verdict.allowed, false);
  assert.match(verdict.allowed ? '' : verdict.reason, /rm/);
  assert.equal(classifyReadOnlyShellCommand('   ').allowed, false);
});


test('inspection denylist trusts unfamiliar commands and quoted query syntax', () => {
  for (const command of [
    'nc -vz -w 5 43.165.185.173 443',
    'git check-ignore -v config.toml .ss-server-state.json',
    'ossutil ls oss://pinet/ 2>&1 | head -40',
    "jq '[.events[]? // .[]? | select((.type // .event) == \"deploy\")]' state.json",
    "rg 'rm|mv|cp|>' src", 'custom-inspector --status',
    'LANG=C git check-ignore -v config.toml', 'command /usr/bin/stat file',
    'command -v rm', 'env -u FOO git status',
    'ls missing 2>/dev/null', 'git log --grep commit',
    'git branch --contains HEAD', 'git branch --list feature', 'git config user.name',
    'git config --get-regexp remote.*', 'git stash list', 'git worktree list',
    "echo '(){} if rm'", 'rg foo \\\n src',
  ]) assert.equal(classifyReadOnlyShellCommand(command).allowed, true, command);
});

test('denylist checks shell boundaries and transparent wrappers', () => {
  for (const command of [
    'env FOO=1 /bin/rm x', 'command rm x', 'ls && /bin/rm x',
    'ls\nrm x', 'ls & rm x', "'r'm x", 'r\\m x',
    'git -C /repo push', 'git branch -D main', 'gh pr merge 1',
    'gh api repos/foo -X POST', 'sed -i.bak s/a/b/ file',
    'env -u FOO rm file', 'env -S \"rm file\"', 'npm --prefix /tmp install',
    'time rm file', 'node -econsole.log(1)', 'python3 -cprint(1)',
    'curl -oout https://example.com',
    '(rm file)', '{ rm file; }', 'if true; then rm file; fi',
    'for f in *; do rm file; done', 'r' + String.fromCharCode(92, 10) + 'm file',
    'git branch new', 'git -C /repo branch new', 'git tag new',
    'git config user.name new', 'git stash', 'git worktree remove foo',
    'git remote set-url origin foo', 'curl -o out https://example.com',
    'echo ok >out', 'cat <<EOF', 'ls > >(tee out)',
  ]) assert.equal(classifyReadOnlyShellCommand(command).allowed, false, command);
});
