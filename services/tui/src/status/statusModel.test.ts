import assert from 'node:assert/strict';
import test from 'node:test';
import type { TuiSessionState } from '../session/sessionController';
import {
  formatComposerPlaceholder,
  formatStatusLine,
  formatStatusLines,
} from './statusModel';

test('status model renders connection, model, token usage, context, and compact cwd', () => {
  const state: TuiSessionState = {
    connection: 'ready',
    session: {
      sessionId: 'chat:one',
      kind: 'chat',
      timeline: [],
      activeRun: null,
      pendingInterrupt: null,
      runtime: {
        model: 'gpt-test',
        modelProfileLabel: 'Primary coding',
        globalReviewPolicyMode: 'require_authorization',
        cwd: '/Users/me/project',
        contextWindow: 128_000,
      },
      sessionTokenUsage: {
        inputTokens: 20_000,
        outputTokens: 3_000,
        totalTokens: 23_000,
        latestInputTokens: 30_000,
        contextWindow: 128_000,
        scope: 'session',
      },
    },
  };

  assert.equal(
    formatStatusLine(state),
    'in/out: 20,000/3,000 · context: 98,000 left · …/me/project',
  );
  assert.equal(
    formatStatusLine(state, 40),
    'in/out: 20,000/3,000 · ctx: 77% left',
  );
  assert.equal(
    formatStatusLine(state, 24),
    'in/out: 20,000/3,000',
  );
  assert.deepEqual(formatStatusLines(state, 80), [
    'connected · policy: ask · Primary coding (gpt-test)',
    'in/out: 20,000/3,000 · context: 98,000 left · …/me/project',
  ]);
  assert.deepEqual(formatStatusLines(state, 32, 'interrupt requested'), [
    'interrupt requested',
    'in/out: 20,000/3,000',
  ]);
});

test('composer placeholder acknowledges active work without blocking drafting', () => {
  const session: TuiSessionState['session'] = {
    sessionId: 'chat:one',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    pendingInterrupt: null,
  };

  assert.equal(
    formatComposerPlaceholder(session),
    'Message · Enter to send · Shift+Enter newline',
  );
  assert.equal(
    formatComposerPlaceholder(session, 'studio'),
    'Studio task · Enter to run · Shift+Enter newline · /chat to exit',
  );
  assert.equal(
    formatComposerPlaceholder({
      ...session,
      activeRun: {
        requestId: 'request',
        state: 'running',
        activity: 'thinking',
      },
    }),
    'Waiting for PinPawo · draft next message · Esc interrupt',
  );
  assert.equal(
    formatComposerPlaceholder({
      ...session,
      actor: {
        label: ' 豆包\n助手 ',
        summary: 'Local helper',
      },
      activeRun: {
        requestId: 'request',
        state: 'running',
        activity: 'using_tool',
      },
    }),
    '豆包 ↵ 助手 is using a tool · draft next message · Esc interrupt',
  );
  assert.equal(
    formatComposerPlaceholder({
      ...session,
      actor: {
        label: '豆包',
        summary: 'Local helper',
      },
      activeRun: {
        requestId: 'request',
        state: 'running',
        activity: 'streaming',
      },
    }),
    '豆包 is responding · draft next message · Esc interrupt',
  );
  assert.equal(
    formatComposerPlaceholder({
      ...session,
      activeRun: null,
      pendingInterrupt: {
        interruptId: 'review-action',
        payload: { kind: 'human_review', interactions: [] },
      },
    }),
    'Review required · use the approval panel',
  );
});
