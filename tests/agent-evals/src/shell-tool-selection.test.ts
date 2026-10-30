import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approvesConfirmed,
  buildShellSelectionMockTools,
  callRunsCommand,
  productionDisposition,
  requestedCommandExecutedEvaluator,
  shellCallCommand,
  shellToolChoiceEvaluator,
  shellToolSelectionExamples,
} from './shell-tool-selection';

type Call = { name: string; args: Record<string, unknown> };

const SHELL_TOOLS = ['inspect_shell', 'get_current_time', 'run_shell', 'start_process',
  'wait_process', 'terminate_process', 'list_processes'];
const SKIP_POSIX = process.platform === 'win32';

function callFor(name: string, command: string): Call {
  return { name, args: { command } };
}

async function withFixture(requested: string | undefined, run: (fixture: ReturnType<typeof buildShellSelectionMockTools>) => Promise<void>) {
  const fixture = buildShellSelectionMockTools(requested);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

const invoke = (fixture: ReturnType<typeof buildShellSelectionMockTools>, name: string, command: string) =>
  fixture.tools.find((candidate) => candidate.name === name)!.invoke({ command }).then(String);

test('shell selection runs the production shell Toolkit in a real repository', { skip: SKIP_POSIX }, async () => {
  await withFixture('git clean -fd', async (fixture) => {
    assert.deepEqual(fixture.tools.map((item) => item.name), SHELL_TOOLS);
    assert.match(await invoke(fixture, 'inspect_shell', 'git log -5 --oneline'), /Add src\/index\.ts/);
    assert.match(await invoke(fixture, 'inspect_shell', 'git status --short 2>&1'), /M src\/cart\.ts[\s\S]*\?\? notes\.txt/);
    assert.match(await invoke(fixture, 'inspect_shell', 'gh pr checks 12'), /build\tpass/);
    assert.match(await invoke(fixture, 'inspect_shell', 'git clean -fd'), /^Error: inspect_shell 不执行该命令/);
    // git localizes its own messages, so check the effect, not the wording.
    await invoke(fixture, 'run_shell', 'git clean -fd');
    assert.equal(await invoke(fixture, 'inspect_shell', 'git status --short'), ' M src/cart.ts');
    assert.equal(shellCallCommand(fixture.calls[4]), 'git clean -fd');
  });
});

test('shell selection review approves reads and the confirmed command, rejects other writes', { skip: SKIP_POSIX }, async () => {
  await withFixture('git push --force origin HEAD', async (fixture) => {
    assert.match(await invoke(fixture, 'run_shell', 'git status --short'), /M src\/cart\.ts/);
    assert.match(await invoke(fixture, 'run_shell', 'git push --force origin HEAD'), /\(no output\)|stderr/);
    const refusal = JSON.parse(await invoke(fixture, 'run_shell', 'git reset --hard HEAD'));
    assert.equal(refusal.source, 'human_reject');
    assert.equal(await invoke(fixture, 'inspect_shell', 'git diff --numstat | tail -1'), '1\t0\tsrc/cart.ts');
  });
});

test('shell selection prompt carries the production shell, git and github toolkit instructions', { skip: SKIP_POSIX }, async () => {
  await withFixture(undefined, async ({ promptSections }) => {
    assert.deepEqual(promptSections.map((section) => section.id), ['toolkit:shell', 'toolkit:git', 'toolkit:github']);
    for (const section of promptSections) assert.ok(section.content.trim());
  });
});

test('the review stand-in approves a chain only when every segment reads or is the confirmed command', () => {
  assert.ok(approvesConfirmed(callFor('run_shell', 'git status --short && git clean -fd'), 'git clean -fd'));
  assert.ok(approvesConfirmed(callFor('run_shell', 'git clean -fd 2>&1; git status'), 'git clean -fd'));
  assert.ok(!approvesConfirmed(callFor('run_shell', 'git clean -fd && rm -rf src'), 'git clean -fd'));
  assert.ok(!approvesConfirmed(callFor('run_shell', 'git reset --hard HEAD; git push -f'), 'git reset --hard HEAD'));
  assert.ok(!approvesConfirmed(callFor('run_shell', 'git clean -fd'), undefined));
});

test('commands match as a chain segment and in any flag order', () => {
  assert.ok(callRunsCommand(callFor('inspect_shell', 'git diff --stat && echo --- && git status'), 'git diff --stat'));
  assert.ok(callRunsCommand(callFor('inspect_shell', 'cd /repo && git --no-pager log --oneline -5'), 'git log -5 --oneline'));
  assert.ok(callRunsCommand(callFor('run_shell', 'git push origin HEAD --force'), 'git push --force origin HEAD'));
  assert.ok(!callRunsCommand(callFor('inspect_shell', 'git diff'), 'git diff --stat'));
  assert.ok(callRunsCommand(callFor('inspect_shell', 'gh pr checks 12 2>&1; echo "exit:$?"'), 'gh pr checks 12'));
  assert.ok(callRunsCommand(callFor('inspect_shell', 'git status --short 2>/dev/null | head'), 'git status --short'));
  assert.ok(!callRunsCommand(callFor('run_shell', 'git clean -nd 2>&1'), 'git clean -fd'));
});

test('production disposition follows admission and review policies', () => {
  assert.equal(productionDisposition(callFor('inspect_shell', 'git status --short')), 'runs');
  assert.equal(productionDisposition(callFor('inspect_shell', 'git clean -fd')), 'refused');
  assert.equal(productionDisposition(callFor('run_shell', 'git clean -fd')), 'reviewed');
  assert.equal(productionDisposition(callFor('run_shell', 'git status --short')), 'reviewed');
  assert.equal(productionDisposition(callFor('run_shell', 'gh pr comment 12 --body LGTM')), 'reviewed');
  assert.equal(productionDisposition(callFor('run_shell', 'npm test')), 'reviewed');
  assert.equal(productionDisposition(callFor('start_process', 'git status')), 'reviewed');
});

test('requested command outcome passes on any path production executes, never on a refused or missing call', () => {
  for (const example of shellToolSelectionExamples) {
    const { names, command } = example.outputs.expected_shell_call;
    const score = (calls: Call[]) => requestedCommandExecutedEvaluator({ outputs: { calls }, referenceOutputs: example.outputs }).score;
    for (const name of [...names, 'run_shell']) assert.equal(score([callFor(name, command)]), 1, `${example.name} via ${name}`);
    assert.equal(score([]), 0);
    assert.equal(score([callFor(names[0], 'echo done')]), 0);
    if (!names.includes('inspect_shell' as never)) {
      assert.equal(score([callFor('inspect_shell', command)]), 0, `${example.name} refused by inspect_shell`);
      assert.equal(score([callFor('inspect_shell', command), callFor(names[0], command)]), 1, `${example.name} corrected`);
    }
  }
});

test('shell choice metric rejects no-op, wrong-command and wrong-tool negative controls', () => {
  for (const example of shellToolSelectionExamples) {
    const { names, command } = example.outputs.expected_shell_call;
    const score = (calls: Call[]) => shellToolChoiceEvaluator({ outputs: { calls }, referenceOutputs: example.outputs }).score;
    for (const name of names) assert.equal(score([callFor(name, command)]), 1, `${example.name} via ${name}`);
    assert.equal(score([]), 0);
    assert.equal(score([callFor(names[0], 'echo done')]), 0);
    for (const wrong of ['inspect_shell', 'run_shell', 'start_process']) {
      if (!names.includes(wrong as never)) assert.equal(score([callFor(wrong, command)]), 0, `${example.name} via ${wrong}`);
    }
    if (!names.includes('inspect_shell' as never)) {
      // A write case may inspect first.
      assert.equal(score([callFor('inspect_shell', 'git status'), callFor(names[0], command)]), 1);
    }
  }
});

test('shell choice metric counts production reviews and refusals', () => {
  const example = shellToolSelectionExamples.find((item) => item.name === 'git-clean-run')!;
  const result = shellToolChoiceEvaluator({
    outputs: { calls: [callFor('inspect_shell', 'git clean -fd'), callFor('run_shell', 'git clean -fd')] },
    referenceOutputs: example.outputs,
  });
  assert.equal(result.score, 0);
  assert.equal(result.reviews, 1);
  assert.equal(result.refusals, 1);
});
