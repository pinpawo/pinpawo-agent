import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_POLICY_GOVERNING_PROMPT } from './contextPolicy.prompt';
import { SUBAGENT_GOVERNING_PROMPT } from './governing.prompt';

test('subagent governing prompt anchors execution to the latest delegation briefing', () => {
  assert.match(SUBAGENT_GOVERNING_PROMPT, /最新的【委派简报】/);
  assert.match(SUBAGENT_GOVERNING_PROMPT, /不要自行处理简报中列出的其他计划事项/);
  assert.doesNotMatch(SUBAGENT_GOVERNING_PROMPT, /任务描述中的每一项都已处理/);
});

test('context policy prompt tells the subagent to preserve important findings', () => {
  assert.match(CONTEXT_POLICY_GOVERNING_PROMPT, /重要发现要随时写进你的回复里/);
});
