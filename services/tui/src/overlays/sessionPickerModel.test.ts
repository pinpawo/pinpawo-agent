import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import type { AgentSessionSummary } from '@pinpawo/agent-session';
import {
  applySessionPickerAction,
  beginSessionPickerLoad,
  beginSessionResume,
  createSessionPickerState,
  formatSessionPicker,
  loadSessionPickerSessions,
  resolveSessionPickerKey,
  selectedSession,
} from './sessionPickerModel';

const sessions: AgentSessionSummary[] = [{
  id: 'active',
  kind: 'chat',
  title: 'Current session',
  messageCount: 4,
  createdAt: '2026-07-27T01:00:00.000Z',
  updatedAt: '2026-07-27T02:00:00.000Z',
  active: true,
}, {
  id: 'previous',
  kind: 'chat',
  title: '之前的中文会话标题',
  messageCount: 8,
  createdAt: '2026-07-26T01:00:00.000Z',
  updatedAt: '2026-07-26T02:00:00.000Z',
  active: false,
}];

test('session picker preserves cached rows while loading and selects an inactive session', () => {
  const previous = loadSessionPickerSessions(sessions);
  assert.deepEqual(beginSessionPickerLoad(previous), {
    phase: 'loading',
    sessions,
    selectedIndex: 1,
  });
  assert.equal(selectedSession(previous)?.id, 'previous');
});

test('session picker owns navigation while ready and locks while resuming', () => {
  let state = loadSessionPickerSessions(sessions);
  assert.equal(resolveSessionPickerKey(state, key('up')), 'move-up');
  state = applySessionPickerAction(state, 'move-up');
  assert.equal(selectedSession(state)?.id, 'active');
  state = beginSessionResume(state);
  assert.equal(state.phase, 'resuming');
  assert.equal(resolveSessionPickerKey(state, key('escape')), null);
  assert.equal(resolveSessionPickerKey(state, key('down')), null);
});

test('Ctrl+R opens a closed picker and Ctrl+C remains global', () => {
  const state = createSessionPickerState();
  assert.equal(resolveSessionPickerKey(state, key('r', true)), 'open');
  const open = loadSessionPickerSessions(sessions);
  assert.equal(resolveSessionPickerKey(open, key('c', true)), null);
});

test('session picker output stays within terminal width for CJK titles', () => {
  const output = formatSessionPicker(loadSessionPickerSessions(sessions), 24);
  for (const line of output.split('\n')) {
    assert.ok(
      stringWidth(line) <= 20,
      `expected width <= 20, got ${stringWidth(line)} for ${line}`,
    );
  }
  assert.match(output, /之前的/);
});

function key(name: string, ctrl = false) {
  return {
    name,
    ctrl,
    meta: false,
    option: false,
  };
}
