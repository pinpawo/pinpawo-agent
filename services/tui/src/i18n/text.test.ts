import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMessageEntry } from '@pinpawo/agent-session';
import { buildMessageDisplayLines } from '../timeline/messageDisplay';
import { resolveTuiLocale, setTuiLocale } from './locale';
import { hostMessageText } from './text';

test('the locale follows PINPAWO_LOCALE, then the POSIX locale variables', () => {
  assert.equal(resolveTuiLocale({}), 'en');
  assert.equal(resolveTuiLocale({ LANG: 'zh_CN.UTF-8' }), 'zh');
  assert.equal(resolveTuiLocale({ LANG: 'zh_CN.UTF-8', LC_ALL: 'en_US.UTF-8' }), 'en');
  assert.equal(resolveTuiLocale({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'zh_TW' }), 'zh');
  assert.equal(resolveTuiLocale({ LANG: 'zh_CN.UTF-8', PINPAWO_LOCALE: 'en' }), 'en');
  assert.equal(resolveTuiLocale({ LANG: 'C.UTF-8', PINPAWO_LOCALE: 'zh' }), 'zh');
});

test('a system notice renders in the TUI language and keeps the Host text otherwise', () => {
  const entry: AgentMessageEntry = {
    id: 'm1',
    type: 'message',
    role: 'system',
    text: 'Authorized run_shell for this session.',
    notice: { code: 'tool_authorized_for_session', params: { toolName: 'run_shell' } },
    status: 'completed',
  };
  try {
    setTuiLocale('en');
    assert.match(buildMessageDisplayLines(entry)[0]!.text, /Authorized run_shell for this session\./);

    setTuiLocale('zh');
    assert.match(buildMessageDisplayLines(entry)[0]!.text, /已授权当前会话中的 run_shell 操作。/);
    // A message without a notice is shown as the Host wrote it.
    assert.match(
      buildMessageDisplayLines({ ...entry, notice: undefined, text: 'plain host text' })[0]!.text,
      /plain host text/,
    );
  } finally {
    setTuiLocale('en');
  }
});

test('Host errors with a known code render in the TUI language', () => {
  try {
    setTuiLocale('zh');
    assert.equal(
      hostMessageText({ message: 'Wait for the current response to finish.', code: 'run_in_flight' }),
      '请等待当前回复结束。',
    );
    assert.equal(hostMessageText({ message: 'raw failure' }), 'raw failure');
    setTuiLocale('en');
    assert.equal(
      hostMessageText({ message: 'Wait for the current response to finish.', code: 'run_in_flight' }),
      'Wait for the current response to finish.',
    );
  } finally {
    setTuiLocale('en');
  }
});
