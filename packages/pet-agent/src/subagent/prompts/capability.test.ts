import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveCapabilitySystemPromptVars } from './capability';
import { CAPABILITY_SYSTEM_PROMPT } from './templates/capability.prompt';

test('Capability System Prompt renders typed sources in deterministic order', () => {
  const vars = deriveCapabilitySystemPromptVars({
    contextSummaryEnabled: true,
    toolkitInstructions: ['TOOLKIT_ONE_POLICY', 'TOOLKIT_TWO_POLICY'],
    capabilityInstruction: 'CAPABILITY_POLICY',
  });
  const prompt = CAPABILITY_SYSTEM_PROMPT.render(vars);

  const summaryIndex = prompt.indexOf(vars.contextSummaryInstruction.trim());
  const toolkitOneIndex = prompt.indexOf('TOOLKIT_ONE_POLICY');
  const toolkitTwoIndex = prompt.indexOf('TOOLKIT_TWO_POLICY');
  const capabilityIndex = prompt.indexOf('CAPABILITY_POLICY');
  assert.ok(summaryIndex >= 0);
  assert.ok(summaryIndex < toolkitOneIndex);
  assert.ok(toolkitOneIndex < toolkitTwoIndex);
  assert.ok(toolkitTwoIndex < capabilityIndex);
});

test('Capability System Prompt omits absent optional variables', () => {
  const vars = deriveCapabilitySystemPromptVars({
    contextSummaryEnabled: false,
    toolkitInstructions: [],
    capabilityInstruction: 'CAPABILITY_POLICY',
  });
  const prompt = CAPABILITY_SYSTEM_PROMPT.render(vars);

  assert.equal(vars.contextSummaryInstruction, '');
  assert.match(prompt, /CAPABILITY_POLICY/);
});

test('Capability System Prompt requires the compiled Capability instruction', () => {
  assert.throws(() => deriveCapabilitySystemPromptVars({
    contextSummaryEnabled: false,
    toolkitInstructions: [],
    capabilityInstruction: ' ',
  }), /requires a Capability instruction/);
});
