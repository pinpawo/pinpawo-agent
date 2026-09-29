import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReadOnlyShellCommand } from './readOnlyShell';

/**
 * `inspect_shell` runs without review, so these cases are the safety boundary
 * itself. A command that reaches execution here reaches it unreviewed.
 */
test('read-only shell refuses anything that can change state', () => {
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
