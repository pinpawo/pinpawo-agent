import assert from 'node:assert/strict';
import test from 'node:test';
import { buildShellSelectionMockTools, shellToolChoiceEvaluator, shellToolSelectionExamples } from './shell-tool-selection';

test('shell selection fixtures record even wrong-tool calls without executing or filtering them', async () => {
  const fixture = buildShellSelectionMockTools();
  for (const name of ['inspect_shell', 'run_shell', 'start_process']) {
    await fixture.tools.find((candidate) => candidate.name === name)!.invoke({ command: 'git reset --hard HEAD' });
  }
  assert.deepEqual(fixture.calls.map((call) => call.name), ['inspect_shell', 'run_shell', 'start_process']);
});

test('shell choice scorer rejects no-op, wrong-command and wrong-tool negative controls', () => {
  for (const example of shellToolSelectionExamples) {
    const { name, command } = example.outputs.expected_shell_call;
    const call: { name: string; args: { command: string } } = { name, args: { command } };
    const score = (calls: typeof call[]) => shellToolChoiceEvaluator({ outputs: { calls }, referenceOutputs: example.outputs }).score;
    assert.equal(score([call]), 1);
    assert.equal(score([]), 0);
    assert.equal(score([{ name, args: { command: 'echo done' } }]), 0);
    assert.equal(score([{ name: name === 'run_shell' ? 'inspect_shell' : 'run_shell', args: { command } }]), 0);
    assert.equal(score([call, { name: 'start_process', args: { command } }]), 0);
    if (name === 'run_shell') assert.equal(score([{ name: 'inspect_shell', args: { command: 'git status' } }, call]), 1);
  }
});
