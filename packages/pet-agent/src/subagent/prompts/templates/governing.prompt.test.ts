import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT,
  SUBAGENT_CONTEXT_SUMMARY_PROMPT,
} from './contextSummary.prompt';
import { SUBAGENT_GOVERNING_PROMPT } from './governing.prompt';

test('subagent governing prompt anchors execution to the latest delegation briefing', () => {
  assert.match(SUBAGENT_GOVERNING_PROMPT, /delegation lane 中最新的【委派简报】/);
  assert.match(SUBAGENT_GOVERNING_PROMPT, /不要自行处理简报中列出的其他计划事项/);
  assert.doesNotMatch(SUBAGENT_GOVERNING_PROMPT, /任务描述中的每一项都已处理/);
});

test('context summary prompt preserves execution state and exact evidence references', () => {
  assert.match(SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT, /自动总结/);
  assert.match(SUBAGENT_CONTEXT_SUMMARY_PROMPT, /当前任务目标/);
  assert.match(SUBAGENT_CONTEXT_SUMMARY_PROMPT, /文件路径、URL、issue\/PR 编号/);
  assert.match(SUBAGENT_CONTEXT_SUMMARY_PROMPT, /\{messages\}/);
});
