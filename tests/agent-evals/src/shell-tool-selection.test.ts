import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildShellSelectionMockTools,
  callRunsCommand,
  productionDisposition,
  requestedCommandExecutedEvaluator,
  shellCallCommand,
  shellToolChoiceEvaluator,
  shellToolSelectionExamples,
} from './shell-tool-selection';

type Call = { name: string; args: Record<string, unknown> };

const ALL_TOOLS = ['inspect_shell', 'run_shell', 'start_process', 'git_shell', 'gh_shell'];

/** The same command expressed as each tool's input. */
function callFor(name: string, command: string): Call {
  if (name === 'git_shell' || name === 'gh_shell') return { name, args: { args: command.split(' ').slice(1) } };
  return { name, args: { command } };
}

test('shell selection fixtures record every call and refuse what production inspect_shell refuses', async () => {
  const fixture = buildShellSelectionMockTools({ 'git reset --hard HEAD': 'done' });
  assert.deepEqual(fixture.tools.map((item) => item.name), ALL_TOOLS);
  const results = [];
  for (const name of ALL_TOOLS) {
    results.push(await fixture.tools.find((candidate) => candidate.name === name)!.invoke(callFor(name, 'git reset --hard HEAD').args));
  }
  assert.deepEqual(fixture.calls.map((call) => call.name), ALL_TOOLS);
  assert.match(String(results[0]), /^Error: inspect_shell 不执行该命令/);
  assert.deepEqual(results.slice(1, 4), ['done', 'done', 'done']);
  assert.equal(shellCallCommand(fixture.calls[3]), 'git reset --hard HEAD');
});

test('shell selection prompt carries the production shell, git and github toolkit instructions', () => {
  const { promptSections } = buildShellSelectionMockTools();
  assert.deepEqual(promptSections.map((section) => section.id), ['toolkit:shell', 'toolkit:git', 'toolkit:github']);
  for (const section of promptSections) assert.ok(section.content.trim());
});

test('commands match as a chain segment and in any flag order', () => {
  assert.ok(callRunsCommand(callFor('inspect_shell', 'git diff --stat && echo --- && git status'), 'git diff --stat'));
  assert.ok(callRunsCommand(callFor('inspect_shell', 'cd /repo && git --no-pager log --oneline -5'), 'git log -5 --oneline'));
  assert.ok(callRunsCommand(callFor('git_shell', 'git push origin HEAD --force'), 'git push --force origin HEAD'));
  assert.ok(!callRunsCommand(callFor('inspect_shell', 'git diff'), 'git diff --stat'));
});

test('production disposition follows admission and review policies', () => {
  assert.equal(productionDisposition(callFor('inspect_shell', 'git status --short')), 'runs');
  assert.equal(productionDisposition(callFor('inspect_shell', 'git clean -fd')), 'refused');
  assert.equal(productionDisposition(callFor('git_shell', 'git clean -fd')), 'reviewed');
  assert.equal(productionDisposition(callFor('git_shell', 'git status --short')), 'runs');
  assert.equal(productionDisposition(callFor('gh_shell', 'gh pr comment 12 --body LGTM')), 'runs');
  assert.equal(productionDisposition(callFor('run_shell', 'git status --short')), 'reviewed');
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
    for (const wrong of ALL_TOOLS) {
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
    outputs: { calls: [callFor('inspect_shell', 'git clean -nd'), callFor('run_shell', 'git clean -fd')] },
    referenceOutputs: example.outputs,
  });
  assert.equal(result.score, 0);
  assert.equal(result.reviews, 1);
  assert.equal(result.refusals, 1);
});
