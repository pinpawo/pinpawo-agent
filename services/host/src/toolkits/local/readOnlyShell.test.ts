import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReadOnlyShellCommand as classify } from './readOnlyShell';

function allows(command: string, expected = true) {
  const result = classify(command);
  assert.equal(result.allowed, expected, `${command}: ${JSON.stringify(result)}`);
}

test('ordinary commands, quoted queries and empty arguments are not dangerous heads', () => {
  for (const command of [
    'ls -la', 'nc -vz example.com 443', 'ossutil ls oss://pinet/ 2>&1 | head',
    'git check-ignore -v file', 'custom-inspector --status', 'git log --grep=rm',
    'cat file | jq ".events | map(.type)"', "jq '.events\n| map(.type)' file",
    "echo 'rm file | sudo ls; kill -9 1'", 'echo "rm | kill"',
    "'' rm file", '"" rm file', "echo ''#text", 'echo ok # ; rm file',
    'cp a b', 'npm install', 'git commit -m x', 'git push', 'git reset --soft HEAD',
    'echo hi > file', 'cat < file', 'rm --help', 'command -v rm',
    'kill -0 123', 'kill -l', 'kill -- -9',
  ]) allows(command);
});

for (const separator of ['|', '&&', '||', ';', '&', '|&']) {
  test(`checks both sides of ${separator} without interpreting quoted operators`, () => {
    allows(`printf ok ${separator} stat file`);
    for (const dangerous of ['rm file', '/bin/rm file', 'env FOO=1 command rm file',
      'kill -9 123']) {
      allows(`printf ok ${separator} ${dangerous}`, false);
      allows(`${dangerous} ${separator} head`, false);
    }
    allows(`echo '${separator} rm file' ${separator} head`);
  });
}

test('small dangerous-operation rules apply at direct and common prefixed heads', () => {
  for (const command of [
    'rm file', 'rm -- --help', 'shred file', 'dd if=image of=/dev/disk0',
    'mkfs.ext4 /dev/sda', 'sudo ls', 'reboot', 'FOO=1 rm file',
    "'r'm file", 'r\\m file', 'env -u FOO /bin/rm file', 'exec -a label rm file',
    'kill -KILL 123', 'kill -SIGKILL 123', 'kill -s KILL 123', 'kill --signal=9 123',
    'if rm file; then ls; fi', 'if true; then rm file; else ls; fi',
    'if false; then ls; else rm file; fi',
  ]) allows(command, false);
  allows('if test -f file; then cat file; else ls; fi');
  allows('', false);
});

test('variable placeholders do not disappear or expand using the Host environment', () => {
  // Erasing $PREFIX would change the first executable into rm.
  allows('$PREFIX"rm" file');
  allows('echo "$VALUE | rm file"');
  allows('echo $VALUE | rm file', false);
  allows('FOO=$VALUE rm file', false);
});

test('library information loss and indirect execution are explicit out-of-scope cases', () => {
  // No source rescanner: newlines, comment termination, FD adjacency and loop
  // bodies are not promised. These strings are classified, never executed.
  for (const command of [
    'ls\nrm file', 'ls # comment\nrm file', '2>/dev/null rm file',
    'r\\\nm file', 'for f in a; do rm file; done',
    'case x in x) rm file ;; esac', '(rm file)',
    'bash -c "rm file"', 'node cleanup.js', 'echo "$(rm file)"',
    'echo ${bad substitution}; rm file', 'echo "unterminated',
  ]) allows(command);
  // shell-quote removes quote provenance; the cheap prefix handling may reject
  // a quoted keyword as well. Do not claim complete shell semantics.
  allows("'if' rm file", false);
});


test('Git semantics are a model tool-selection responsibility, not admission rules', () => {
  for (const command of ['git status', 'git log', 'git diff', 'git reset --hard',
    'git -C /repo reset --hard', 'git clean -fd', 'git push --force', 'git branch -D main']) {
    allows(command);
  }
  allows('git status | rm file', false);
});
