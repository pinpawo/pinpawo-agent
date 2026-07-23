import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInitialTuiInputBufferState,
  isTerminalControlSequence,
  isTerminalControlSequencePrefix,
  normalizeTuiInputEvent,
} from './terminalInput';

test('normalizeTuiInputEvent passes key-only events through', () => {
  const key = { return: true };
  const normalized = normalizeTuiInputEvent('', key, createInitialTuiInputBufferState());

  assert.deepEqual(normalized, {
    state: { pendingControlSequence: '' },
    event: { input: '', key },
  });
});

test('normalizeTuiInputEvent buffers split terminal control sequences', () => {
  let state = createInitialTuiInputBufferState();
  let normalized = normalizeTuiInputEvent('\x1b[', {}, state);
  assert.equal(normalized.event, null);
  state = normalized.state;

  normalized = normalizeTuiInputEvent('13;2u', {}, state);
  assert.deepEqual(normalized, {
    state: { pendingControlSequence: '' },
    event: { input: '\x1b[13;2u', key: {} },
  });
});

test('normalizeTuiInputEvent emits original input when a pending sequence cannot complete', () => {
  let state = createInitialTuiInputBufferState();
  let normalized = normalizeTuiInputEvent('[2', {}, state);
  assert.equal(normalized.event, null);
  state = normalized.state;

  normalized = normalizeTuiInputEvent('!', {}, state);
  assert.deepEqual(normalized, {
    state: { pendingControlSequence: '' },
    event: { input: '!', key: {} },
  });
});

test('terminal input helpers classify complete control sequences and prefixes', () => {
  assert.equal(isTerminalControlSequence('\x1b[1;2A'), true);
  assert.equal(isTerminalControlSequence('[27;2;13~'), true);
  assert.equal(isTerminalControlSequence('[27;2;13'), false);

  assert.equal(isTerminalControlSequencePrefix('\x1b['), true);
  assert.equal(isTerminalControlSequencePrefix('[27;2;13'), true);
  assert.equal(isTerminalControlSequencePrefix('[27;2;13~'), false);

});
