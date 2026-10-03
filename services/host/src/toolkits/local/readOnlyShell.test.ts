import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReadOnlyShellCommand } from './readOnlyShell';

function allows(command: string, expected = true) {
  const verdict = classifyReadOnlyShellCommand(command);
  assert.equal(verdict.allowed, expected, `${command}: ${verdict.allowed ? 'allowed' : verdict.reason}`);
}

test('inspection trusts common and unfamiliar commands without enumerating ordinary mutations', () => {
  for (const command of [
    'ls -la', 'pwd', 'git status', 'git log --oneline -20', 'git diff main HEAD',
    'git rev-parse --abbrev-ref HEAD', 'git show HEAD --stat',
    'cd /repo && grep -rn "foo" src', 'cd /repo && git log --oneline | head -20',
    'cat package.json | jq .name', 'find . -name "*.ts" | head',
    'echo "=== section ===" && sed -n "1,40p" file.ts', 'wc -l src/index.ts',
    'nc -vz -w 5 example.com 443', 'git check-ignore -v config.toml',
    'ossutil ls oss://pinet/ 2>&1 | head -40', 'custom-inspector --status',
    'LANG=C git check-ignore -v config.toml', 'command /usr/bin/stat file',
    'command -v rm', 'env -u FOO git status', 'ls missing 2>/dev/null',
    'git log --grep commit', 'git branch --contains HEAD', 'git branch --list feature',
    'git config user.name', 'git config --get-regexp remote.*', 'git stash list',
    'git worktree list', 'rg foo \\\n src',
    // Admission is intentionally best-effort, not a read-only guarantee. The tool
    // instructions still direct intentional writes to run_shell.
    'cp a b', 'mv a b', 'mkdir dir', 'touch file', 'tee out.txt',
    'npm install', 'npm --prefix /tmp install', 'pnpm add example', 'yarn run test',
    'sed -i.bak s/a/b/ file', 'git fetch', 'git checkout main', 'git commit -m x',
    'git push', 'git reset --soft HEAD', 'git branch new', 'git tag new',
    'git config user.name new', 'git remote set-url origin foo',
    'gh pr view 1', 'gh api repos/foo -X GET', 'curl -o out https://example.com',
  ]) allows(command);
});

test('inspection blocks a few obvious high-risk operations', () => {
  for (const command of [
    'rm -rf /', 'rm -- --help', 'shred file', 'dd if=image of=/dev/disk0',
    'mkfs.ext4 /dev/sda', 'sudo ls', 'reboot',
    'git clean -fd', 'git reset --hard', 'git -C /repo reset --hard',
    'git push --force', 'git push --force-with-lease=main:abc', 'git push -f',
    'git push origin +main', 'git branch -D main',
  ]) allows(command, false);
});

test('control syntax and command grouping admit ordinary inspections', () => {
  for (const command of [
    'if test -f a; then cat a; else ls; fi',
    'if false; then ls; elif test -d b; then pwd; else git status; fi',
    'if\n test -d a\nthen\nls\nelse\npwd\nfi',
    'for f in a b; do stat "$f"; done', 'for f; do echo "$f"; done',
    'for f\ndo stat "$f"; done', 'for f\nin a b\ndo echo "$f"; done',
    'while test -f a; do cat a; done', 'until test -f a; do ls; done',
    'case "$f" in a|b) ls ;; (c) pwd ;& *) git status ;; esac',
    '(ls; pwd) | head', '{ ls; pwd; }',
    'if true; then for f in a; do (stat "$f"); done; fi',
    '! test -f file || ls', 'time -p if true; then ls; fi',
    '[[ -f a && -r a ]] && cat a',
    'inspect() { ls; }', 'function inspect { pwd; }',
    'ls & pwd', 'ls # rm file\n pwd', 'ls |& head',
  ]) allows(command);
});

// Recognizable static bodies/conditions are checked regardless of which path runs.
const positions = [
  (c: string) => `if ${c}; then ls; fi`,
  (c: string) => `if true; then ${c}; fi`,
  (c: string) => `if false; then ls; else ${c}; fi`,
  (c: string) => `if false; then ls; elif ${c}; then pwd; fi`,
  (c: string) => `if false; then ls; elif true; then ${c}; fi`,
  (c: string) => `for f in a b; do ${c}; done`,
  (c: string) => `while ${c}; do ls; done`,
  (c: string) => `while true; do ${c}; done`,
  (c: string) => `until ${c}; do ls; done`,
  (c: string) => `until true; do ${c}; done`,
  (c: string) => `case x in x) ${c} ;; *) ls ;; esac`,
  (c: string) => `case x in x) ls ;;& *) ${c} ;; esac`,
  (c: string) => `(${c})`, (c: string) => `{ ${c}; }`,
  (c: string) => `inspect() { ${c}; }`,
  (c: string) => `! ${c}`, (c: string) => `time ${c}`,
  (c: string) => `ls; ${c}`, (c: string) => `ls\n${c}`,
  (c: string) => `ls && ${c}`, (c: string) => `ls || ${c}`,
  (c: string) => `ls | ${c}`, (c: string) => `${c} | head`,
  (c: string) => `ls & ${c}`, (c: string) => `ls |& ${c}`,
  (c: string) => `if true; then for f in a; do { ${c}; }; done; fi`,
];
for (const position of positions) {
  test(`checks actual command position: ${position('COMMAND')}`, () => {
    allows(position('stat file'));
    for (const command of ['rm file', 'env -u FOO command /bin/rm file', 'git -C /repo reset --hard']) {
      allows(position(command), false);
    }
  });
}

test('quoted payloads, loop values, patterns and test operands are not commands', () => {
  for (const command of [
    "jq '[.events[]? // .[]? | select((.type // .event) == \"deploy\")]' state.json",
    "rg 'rm|mv|cp|>' src", "echo '(){} if rm; then sudo; fi'",
    'echo "rm; sudo | dd && reboot"', 'echo if then else rm',
    'for f in rm sudo do done; do echo "$f"; done',
    'case rm in rm|sudo) echo rm ;; esac',
    '[[ rm == rm ]] && echo rm', '[ rm = rm ] && echo rm',
    'if test "rm; sudo" = x; then echo "then rm"; fi',
    'echo \\; rm file',
  ]) allows(command);
  for (const command of ["'r'm file", 'r\\m file', 'r\\\nm file',
    'FOO=1 rm file', 'env FOO=1 /bin/rm file', 'command rm file',
    'env -- FOO=1 command rm file', 'builtin exec rm file', 'exec -a name rm file', 'nohup rm file',
    'if true; then "rm" file; fi', '2>/dev/null rm file',
  ]) allows(command, false);
});

test('syntax and indirect code are left to the shell and model, not blanket-reviewed', () => {
  for (const command of [
    'if true; then ls', 'for f in a; ls', '(ls', 'function inspect ls',
    'echo "unterminated', 'echo \\', 'cat < README.md', 'echo hi > /tmp/f',
    'cat <<EOF', 'echo $(pwd)', 'echo `whoami`', 'cat <(ls)',
    'bash -c "rm file"', 'node -e "process.exit()"', 'python3 -c "import os"',
    'eval "rm file"', 'source file', 'env -S "rm file"',
    'node cleanup.js', 'npm run cleanup', '${CMD} file', 'r{m,mdir} file',
    'echo "$(rm file)"', 'find . -exec rm {} \\;', 'find . -delete',
    'rm --help', 'chmod +x file', 'kill -9 1', 'rmdir dir',
  ]) allows(command);
  // This is deliberately not a proof against indirect execution. Conversely,
  // obvious heads are still checked without requiring a well-formed program.
  allows('if true; then rm file', false);
  const verdict = classifyReadOnlyShellCommand('cd /repo && rm -rf build');
  assert.match(verdict.allowed ? '' : verdict.reason, /rm/);
  allows('   ', false);
});
