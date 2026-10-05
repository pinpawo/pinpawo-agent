import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildShellSelectionMockTools,
  shellCallCommand,
  shellToolChoiceEvaluator,
  shellToolSelectionExamples,
} from './shell-tool-selection';

type Call = { name: string; args: Record<string, unknown> };

/** The same command expressed as each tool's input. */
function callFor(name: string, command: string): Call {
  if (name === 'git_shell' || name === 'gh_shell') return { name, args: { args: command.split(' ').slice(1) } };
  return { name, args: { command } };
}

test('shell selection fixtures record even wrong-tool calls without executing or filtering them', async () => {
  const fixture = buildShellSelectionMockTools();
  const names = ['inspect_shell', 'run_shell', 'start_process', 'git_shell', 'gh_shell'];
  assert.deepEqual(fixture.tools.map((item) => item.name), names);
  for (const name of names) {
    await fixture.tools.find((candidate) => candidate.name === name)!.invoke(callFor(name, 'git reset --hard HEAD').args);
  }
  assert.deepEqual(fixture.calls.map((call) => call.name), names);
  assert.equal(shellCallCommand(fixture.calls[3]), 'git reset --hard HEAD');
});

test('shell choice scorer rejects no-op, wrong-command and wrong-tool negative controls', () => {
  for (const example of shellToolSelectionExamples) {
    const { names, command } = example.outputs.expected_shell_call;
    const score = (calls: Call[]) => shellToolChoiceEvaluator({ outputs: { calls }, referenceOutputs: example.outputs }).score;
    for (const name of names) assert.equal(score([callFor(name, command)]), 1, `${example.name} via ${name}`);
    assert.equal(score([]), 0);
    assert.equal(score([callFor(names[0], 'echo done')]), 0);
    for (const wrong of ['inspect_shell', 'run_shell', 'start_process', 'git_shell', 'gh_shell']) {
      if (!names.includes(wrong as never)) assert.equal(score([callFor(wrong, command)]), 0, `${example.name} via ${wrong}`);
    }
    if (!names.includes('inspect_shell' as never)) {
      // A write case may inspect first.
      assert.equal(score([callFor('inspect_shell', 'git status'), callFor(names[0], command)]), 1);
    }
  }
});
