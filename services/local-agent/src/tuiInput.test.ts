import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTuiCommandHelp,
  listTuiCommands,
  parseTuiCommand,
} from './tui/input/commandRegistry';
import { buildApprovalOptions } from './tui/approvalOptions';
import {
  applyComposerInput,
  resolveTuiKeyAction,
  type ComposerInputState,
  type TuiKeyInput,
} from './tui/input/keymap';

test('parseTuiCommand parses text, aliases, args, and unknown commands', () => {
  assert.deepEqual(parseTuiCommand('hello'), {
    type: 'text',
    text: 'hello',
  });
  assert.deepEqual(parseTuiCommand('/'), {
    type: 'command',
    command: listTuiCommands().find((command) => command.name === 'help'),
    name: 'help',
    raw: '/',
    args: '',
  });

  const studio = parseTuiCommand('/studio build a poster');
  assert.equal(studio.type, 'command');
  assert.equal(studio.type === 'command' ? studio.name : null, 'studio');
  assert.equal(studio.type === 'command' ? studio.args : null, 'build a poster');

  const exit = parseTuiCommand('/exit');
  assert.equal(exit.type, 'command');
  assert.equal(exit.type === 'command' ? exit.name : null, 'quit');

  const exportCommand = parseTuiCommand('/export transcripts/today.md');
  assert.equal(exportCommand.type, 'command');
  assert.equal(exportCommand.type === 'command' ? exportCommand.name : null, 'export');
  assert.equal(exportCommand.type === 'command' ? exportCommand.args : null, 'transcripts/today.md');

  const resumeCommand = parseTuiCommand('/resume');
  assert.equal(resumeCommand.type, 'command');
  assert.equal(resumeCommand.type === 'command' ? resumeCommand.name : null, 'resume');

  assert.deepEqual(parseTuiCommand('/studiox'), {
    type: 'unknown',
    raw: '/studiox',
    name: 'studiox',
    args: '',
  });
});

test('parseTuiCommand treats slash-prefixed non-command shapes as plain text', () => {
  // Absolute paths must reach the agent unchanged, not surface "unknown
  // command" feedback that swallows the message.
  assert.deepEqual(
    parseTuiCommand('/Users/wangxianbin/Develop/src/hughub/ look at this'),
    { type: 'text', text: '/Users/wangxianbin/Develop/src/hughub/ look at this' },
  );
  assert.deepEqual(parseTuiCommand('/etc/hosts'), {
    type: 'text',
    text: '/etc/hosts',
  });
  // Double slash and leading-non-letter forms also fall through to chat.
  assert.deepEqual(parseTuiCommand('//comment'), {
    type: 'text',
    text: '//comment',
  });
  assert.deepEqual(parseTuiCommand('/123abc'), {
    type: 'text',
    text: '/123abc',
  });
  // /<name>-<rest> is still a valid command-name shape (kebab-case names
  // could be added later); preserve as unknown so feedback still fires.
  assert.deepEqual(parseTuiCommand('/foo-bar'), {
    type: 'unknown',
    raw: '/foo-bar',
    name: 'foo-bar',
    args: '',
  });
});

test('formatTuiCommandHelp is generated from visible command metadata', () => {
  assert.equal(
    formatTuiCommandHelp(),
    '/new 新会话 · /studio [任务] 进入 Studio 模式 · /chat 退出 Studio · /help · /export [path] 导出 transcript(默认当前目录) · /resume 恢复会话 · /quit',
  );
});

test('resolveTuiKeyAction routes global, approval, busy, and composer keys', () => {
  assert.deepEqual(
    resolveTuiKeyAction('c', { ctrl: true }, { ready: false, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'global.ctrl_c' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { upArrow: true }, { ready: true, busy: false, hasPendingApproval: true, hasResumePicker: false }),
    { type: 'approval.previous' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { return: true }, { ready: true, busy: false, hasPendingApproval: true, hasResumePicker: false }),
    { type: 'approval.submit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('x', {}, { ready: true, busy: false, hasPendingApproval: true, hasResumePicker: false }),
    { type: 'composer.edit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { escape: true }, { ready: true, busy: true, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'global.interrupt' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { escape: true }, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'composer.clear' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { return: true }, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: false }),
    { type: 'composer.submit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { downArrow: true }, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: true }),
    { type: 'resume.next' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { return: true }, { ready: true, busy: false, hasPendingApproval: false, hasResumePicker: true }),
    { type: 'resume.submit' },
  );
});

test('applyComposerInput keeps cursor editing behavior in pure input reducer', () => {
  let state: ComposerInputState = { value: 'helo', cursorOffset: 2 };
  state = applyComposerInput('l', {}, state);
  assert.deepEqual(state, { value: 'hello', cursorOffset: 3 });

  state = applyComposerInput('', { leftArrow: true }, state);
  assert.deepEqual(state, { value: 'hello', cursorOffset: 2 });

  state = applyComposerInput('', { backspace: true }, state);
  assert.deepEqual(state, { value: 'hllo', cursorOffset: 1 });

  state = applyComposerInput('e', { ctrl: true }, state);
  assert.deepEqual(state, { value: 'hllo', cursorOffset: 4 });

  state = applyComposerInput('', { ctrl: true } as TuiKeyInput, state);
  assert.deepEqual(state, { value: 'hllo', cursorOffset: 4 });

  state = { value: 'run shell command', cursorOffset: 'run shell'.length };
  assert.deepEqual(applyComposerInput('w', { ctrl: true }, state), {
    value: 'run  command',
    cursorOffset: 4,
  });
});

test('buildApprovalOptions maps canonical review options without reading tool payloads', () => {
  const options = buildApprovalOptions({
    requestId: 'req-1',
    kind: 'tool',
    prompt: 'Run command?',
    payload: {},
    review: {
      id: 'review-1',
      schemaVersion: 1,
      view: { kind: 'plain', body: 'Run command?' },
      options: [{
        id: 'approve',
        label: 'Approve',
        variant: 'primary',
        decision: { type: 'approve' },
      }, {
        id: 'respond',
        label: 'Respond',
        description: 'Ask the agent to revise the plan.',
        input: { kind: 'text', key: 'message', required: true, multiline: true },
        decision: { type: 'respond', messageInputKey: 'message' },
      }],
    },
  });

  assert.deepEqual(options, [
    {
      label: 'Approve',
      message: 'Approve',
      variant: 'primary',
      reviewId: 'review-1',
      selectedOptionId: 'approve',
    },
    {
      label: 'Respond',
      message: 'Respond',
      description: 'Ask the agent to revise the plan.',
      reviewId: 'review-1',
      selectedOptionId: 'respond',
      input: { kind: 'text', key: 'message', required: true, multiline: true },
    },
  ]);
});

test('buildApprovalOptions returns no options without canonical review spec', () => {
  const options = buildApprovalOptions({
    requestId: 'req-1',
    kind: 'tool',
    prompt: 'Run command?',
    payload: {},
  });

  assert.deepEqual(options, []);
});
