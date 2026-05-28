import assert from 'node:assert/strict';
import test from 'node:test';
import { presentStudioTurnEvent } from './presentation/studioPresentation';
import { presentToolResult, presentToolStart } from './presentation/toolPresentation';
import { renderZhCN } from './presentation/zhCN';

test('tool presentation returns structured messages rendered by locale layer', () => {
  const start = presentToolStart('read_file', JSON.stringify({ path: '/tmp/example.md' }));
  assert.equal(renderZhCN(start.label), '读文件');
  assert.equal(renderZhCN(start.detail), '/tmp/example.md');

  const result = presentToolResult({
    toolName: 'write_file',
    input: '{}',
    output: JSON.stringify({ ok: true, path: '/tmp/output.md' }),
    error: '',
  });
  assert.equal(renderZhCN(result), '已写入 /tmp/output.md');
});

test('tool presentation preserves plain text result summaries', () => {
  const result = presentToolResult({
    toolName: 'grep_search',
    input: '{}',
    output: '/tmp/example.md:1: hello',
    error: '',
  });
  assert.equal(renderZhCN(result), '命中 /tmp/example.md:1: hello');
});

test('studio event presentation is separated from TUI rendering', () => {
  const line = presentStudioTurnEvent({
    type: 'dispatch_started',
    petId: 'pet-1',
    taskIndex: 2,
  });
  assert.equal(renderZhCN(line), '[studio] dispatch[#2] → pet:pet-1');
});
