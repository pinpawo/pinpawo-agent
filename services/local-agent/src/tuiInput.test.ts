import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTuiCommandHelp,
  listTuiCommands,
  parseTuiCommand,
} from './tui/input/commandRegistry';
import { buildApprovalOptions } from './tui/components/ApprovalPanel';
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

  assert.deepEqual(parseTuiCommand('/studiox'), {
    type: 'unknown',
    raw: '/studiox',
    name: 'studiox',
    args: '',
  });
});

test('formatTuiCommandHelp is generated from visible command metadata', () => {
  assert.equal(
    formatTuiCommandHelp(),
    '/new 新会话 · /studio [任务] 进入 Studio 模式 · /chat 退出 Studio · /help · /export [path] 导出 transcript(默认当前目录) · /quit',
  );
});

test('resolveTuiKeyAction routes global, approval, busy, and composer keys', () => {
  assert.deepEqual(
    resolveTuiKeyAction('c', { ctrl: true }, { ready: false, busy: false, hasPendingApproval: false }),
    { type: 'global.ctrl_c' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { upArrow: true }, { ready: true, busy: false, hasPendingApproval: true }),
    { type: 'approval.previous' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { return: true }, { ready: true, busy: false, hasPendingApproval: true }),
    { type: 'approval.submit' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { escape: true }, { ready: true, busy: true, hasPendingApproval: false }),
    { type: 'global.interrupt' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { escape: true }, { ready: true, busy: false, hasPendingApproval: false }),
    { type: 'composer.clear' },
  );
  assert.deepEqual(
    resolveTuiKeyAction('', { return: true }, { ready: true, busy: false, hasPendingApproval: false }),
    { type: 'composer.submit' },
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

test('buildApprovalOptions derives action review decisions from normalized approval payload', () => {
  const options = buildApprovalOptions({
    requestId: 'req-1',
    kind: 'tool',
    prompt: 'Run command?',
    payload: {
      actionRequests: [{
        name: 'run_shell',
        args: { command: 'git status --short' },
      }],
      reviewConfigs: [{
        allowedDecisions: ['approve', 'reject'],
      }],
    },
  });

  assert.deepEqual(options, [
    {
      label: '批准执行',
      message: '批准执行',
      resume: { decisions: [{ type: 'approve' }] },
    },
    {
      label: '本次会话授权：git status --short',
      message: '/allow',
    },
    {
      label: '拒绝',
      message: '拒绝',
      resume: { decisions: [{ type: 'reject' }] },
    },
  ]);
});
