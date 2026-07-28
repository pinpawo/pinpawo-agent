import assert from 'node:assert/strict';
import test from 'node:test';
import type { TuiSessionState } from '../session/sessionController';
import {
  formatComposerPlaceholder,
  formatHeader,
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
      runtime: {
        model: 'gpt-test',
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
    formatHeader(state),
    'PinPawo TUI v2 · v0.1.0 · connected · gpt-test',
  );
  assert.equal(
    formatHeader(state, Number.POSITIVE_INFINITY, 'studio'),
    'PinPawo TUI v2 · v0.1.0 · connected · studio · gpt-test',
  );
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
  assert.equal(formatHeader(state, 28), 'PinPawo TUI v2 · v0.1.0');
  assert.deepEqual(formatStatusLines(state, 80), [
    'connected · idle · policy: ask · gpt-test',
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
  };

  assert.equal(
    formatComposerPlaceholder(session),
    'Message · Ctrl+Enter or Ctrl+O to send',
  );
  assert.equal(
    formatComposerPlaceholder(session, 'studio'),
    'Studio task · Ctrl+Enter/Ctrl+O run · /chat to exit',
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
      activeRun: {
        requestId: 'request',
        state: 'waiting_review',
        reviewAction: {
          actionId: 'review-action',
          reviews: [],
        },
      },
    }),
    'Review required · use the approval panel',
  );
});
