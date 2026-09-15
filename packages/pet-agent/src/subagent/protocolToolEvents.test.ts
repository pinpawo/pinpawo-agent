import assert from 'node:assert/strict';
import test from 'node:test';
import { NamespacedProtocolToolEventReader } from './protocolToolEvents';
import { buildReviewSpec } from '../types/reviewSpec';

test('a nested review batch interrupts delegation without emitting a tool failure', () => {
  const reader = new NamespacedProtocolToolEventReader();
  const scope = ['tools:root'];
  reader.readToolsData(scope, { event: 'tool-started', tool_call_id: 'delegate', tool_name: 'delegate_capability' });
  const review = buildReviewSpec({ id: 'review', view: { kind: 'plain', body: 'Write file?' }, options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }] });
  const result = reader.readToolsData(scope, {
    event: 'tool-error', tool_call_id: 'delegate',
    message: JSON.stringify([{ id: 'interrupt', value: { kind: 'review_batch', reviews: [{
      kind: 'review', review,
      pendingAction: { actionId: 'inner-write', toolName: 'write_file', args: { path: '/tmp/report.txt' } },
    }] } }]),
  });
  assert.equal(result, null);
  reader.readToolsData(scope, { event: 'tool-started', tool_call_id: 'next', tool_name: 'read_file' });
  assert.equal(reader.readToolsData(scope, {
    event: 'tool-error', tool_call_id: 'next', message: 'Permission denied',
  })?.event, 'on_tool_error');
});

test('keeps reader state per namespace when scopes reuse the same tool_call_id', () => {
  const reader = new NamespacedProtocolToolEventReader();
  const mainScope = ['general:t1', 'tools:t2'];
  const subagentScope = ['general:t1', 'subagent:s1', 'tools:t3'];

  const mainStarted = reader.readToolsData(mainScope, {
    event: 'tool-started',
    tool_call_id: 'call-dup',
    tool_name: 'read_file',
    input: { path: 'README.md' },
  });
  assert.equal(mainStarted?.event, 'on_tool_start');
  assert.equal(mainStarted?.name, 'read_file');

  // Same call id from another scope while the first is still active: must not
  // be dropped as a duplicate, and must not overwrite the first scope's name.
  const subagentStarted = reader.readToolsData(subagentScope, {
    event: 'tool-started',
    tool_call_id: 'call-dup',
    tool_name: 'run_shell',
    input: { command: 'ls' },
  });
  assert.equal(subagentStarted?.event, 'on_tool_start');
  assert.equal(subagentStarted?.name, 'run_shell');

  const mainFinished = reader.readToolsData(mainScope, {
    event: 'tool-finished',
    tool_call_id: 'call-dup',
    output: 'contents',
  });
  assert.equal(mainFinished?.event, 'on_tool_end');
  assert.equal(mainFinished?.name, 'read_file');

  // The main scope finishing call-dup must not mark the subagent's call
  // finished: its terminal event still resolves, with its own name.
  const subagentFinished = reader.readToolsData(subagentScope, {
    event: 'tool-finished',
    tool_call_id: 'call-dup',
    output: 'ok',
  });
  assert.equal(subagentFinished?.event, 'on_tool_end');
  assert.equal(subagentFinished?.name, 'run_shell');

  // Within one scope, duplicate terminal events are still deduplicated.
  assert.equal(reader.readToolsData(mainScope, {
    event: 'tool-finished',
    tool_call_id: 'call-dup',
    output: 'contents',
  }), null);
});
