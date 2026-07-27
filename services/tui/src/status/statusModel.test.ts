import assert from 'node:assert/strict';
import test from 'node:test';
import type { TuiSessionState } from '../session/sessionController';
import {
  formatHeader,
  formatStatusLine,
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

  assert.equal(formatHeader(state), 'PinPawo TUI v2 · connected · gpt-test');
  assert.equal(
    formatStatusLine(state),
    'in/out: 20,000/3,000 · context: 98,000 left · …/me/project',
  );
});
