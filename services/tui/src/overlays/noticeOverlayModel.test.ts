import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import type { TuiSessionState } from '../session/sessionController';
import {
  buildNoticeOverlayViewModel,
  closeNoticeOverlay,
  createNoticeOverlayState,
  openErrorNotice,
  resolveNoticeOverlayKey,
  syncNoticeOverlay,
} from './noticeOverlayModel';

test('notice follows canonical interrupting state and closes when the run settles', () => {
  const interrupting = syncNoticeOverlay(
    createNoticeOverlayState(),
    sessionState({
      requestId: 'run-1',
      state: 'interrupting',
    }),
  );
  assert.deepEqual(interrupting, {
    phase: 'interrupting',
    requestId: 'run-1',
  });
  assert.deepEqual(
    syncNoticeOverlay(interrupting, sessionState(null)),
    { phase: 'closed' },
  );
});

test('error notice is dismissible and width safe', () => {
  const state = openErrorNotice(
    '连接失败：本地服务返回了一个很长的错误消息，需要安全换行。',
  );
  assert.equal(resolveNoticeOverlayKey(state, { name: 'escape' }), 'close');
  if (state.phase === 'closed') assert.fail('error notice should be open');
  const view = buildNoticeOverlayViewModel(state, 24);
  for (const line of view.content.split('\n')) {
    assert.ok(stringWidth(line) <= 20, line);
  }
  assert.deepEqual(closeNoticeOverlay(), { phase: 'closed' });
});

test('connection errors open once and close after authoritative recovery', () => {
  const errored = syncNoticeOverlay(createNoticeOverlayState(), {
    ...sessionState(null),
    connection: 'error',
    connectionDetail: 'socket failed',
  });
  assert.deepEqual(errored, {
    phase: 'error',
    source: 'connection',
    message: 'socket failed',
  });
  assert.deepEqual(syncNoticeOverlay(errored, sessionState(null)), {
    phase: 'closed',
  });
});

function sessionState(
  activeRun: TuiSessionState['session']['activeRun'],
): TuiSessionState {
  return {
    connection: 'ready',
    session: {
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun,
    },
  };
}
