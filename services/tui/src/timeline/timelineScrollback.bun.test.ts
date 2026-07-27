import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import { formatTimelineEntry } from './timelineModel';
import {
  MAX_SETTLED_ENTRIES_PER_COMMIT,
  TimelineScrollback,
} from './timelineScrollback';

test('streaming timeline commits stable rows incrementally and finalizes once', async () => {
  const setup = await createTimelineRenderer(20);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const streaming = assistantMessage(
      'abcdefghijklmnopqrstuvwxyz0123456789',
      'streaming',
    );
    timeline.render(session([streaming], 'request-1'));
    const first = setup.externalOutput.take();
    assert.ok(first.length > 0);

    const grown = {
      ...streaming,
      text: `${streaming.text}ABCDEFGHIJKLMNOPQRSTUVWXYZ`,
    };
    timeline.render(session([grown], 'request-1'));
    const second = setup.externalOutput.take();
    assert.ok(second.length > 0);

    const completed = { ...grown, status: 'completed' as const };
    timeline.render(session([completed]));
    const final = setup.externalOutput.take();
    assert.ok(final.length > 0);

    const committedText = [...first, ...second, ...final]
      .flatMap((commit) => commit.rows)
      .join('');
    assert.equal(
      committedText.replaceAll(/\s/g, ''),
      formatTimelineEntry(completed).replaceAll(/\s/g, ''),
    );
    timeline.render(session([completed]));
    assert.deepEqual(setup.externalOutput.take(), []);
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('welcome is committed once before the first timeline rows', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    timeline.renderWelcome(['paw', 'PinPawo TUI v2']);
    timeline.renderWelcome(['must not repeat']);
    timeline.render(session([userMessage('hello')]));
    assert.equal(
      setup.externalOutput.takeText(),
      ['paw', 'PinPawo TUI v2', formatTimelineEntry(userMessage('hello'))].join('\n'),
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('a running operation prevents later rows from committing out of order', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const user = userMessage('inspect');
    timeline.render(session([user], 'request-1'));
    setup.externalOutput.clear();

    const operation: AgentTimelineEntry = {
      id: 'operation-1',
      type: 'operation',
      requestId: 'request-1',
      operationKey: 'operation-1',
      kind: 'test',
      title: 'Read file',
      phase: 'started',
    };
    const subagent: AgentTimelineEntry = {
      id: 'subagent-1',
      type: 'message',
      role: 'subagent',
      text: 'found evidence',
      status: 'completed',
      requestId: 'request-1',
    };
    timeline.render(session([user, operation, subagent], 'request-1'));
    assert.deepEqual(setup.externalOutput.take(), []);

    const completedOperation = {
      ...operation,
      phase: 'completed' as const,
    };
    timeline.render(session([user, completedOperation, subagent]));
    assert.equal(
      setup.externalOutput.takeText(),
      [
        formatTimelineEntry(completedOperation),
        formatTimelineEntry(subagent),
      ].join('\n'),
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('long sessions use bounded native scrollback commits', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const entries = Array.from(
      { length: MAX_SETTLED_ENTRIES_PER_COMMIT * 2 + 1 },
      (_, index) => userMessage(`message ${index + 1}`, `user-${index}`),
    );
    timeline.render(session(entries));
    const commits = setup.externalOutput.take();
    assert.equal(commits.length, 3);
    assert.deepEqual(
      commits.map((commit) => commit.height),
      [
        MAX_SETTLED_ENTRIES_PER_COMMIT,
        MAX_SETTLED_ENTRIES_PER_COMMIT,
        1,
      ],
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('a new submitted turn advances native scrollback after prior history', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const first = userMessage('first', 'user-1');
    timeline.render(session([first]));
    setup.externalOutput.clear();

    const second = userMessage('second', 'user-2');
    timeline.render(session([first, second], 'request-2'));
    assert.equal(
      setup.externalOutput.takeText(),
      formatTimelineEntry(second),
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('an authoritative session boundary allows identical text in the new session', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const repeated = userMessage('same text', 'old-user');
    timeline.render(session([repeated], undefined, 'session-old'));
    setup.externalOutput.clear();

    timeline.render(session([], undefined, 'session-new'));
    assert.match(setup.externalOutput.takeText(), /session session-new/);

    timeline.render(session([
      userMessage('same text', 'new-user'),
    ], undefined, 'session-new'));
    assert.equal(
      setup.externalOutput.takeText(),
      formatTimelineEntry(repeated),
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

async function createTimelineRenderer(width: number) {
  return createTestRenderer({
    width,
    height: 24,
    screenMode: 'split-footer',
    footerHeight: 9,
    externalOutputMode: 'capture-stdout',
  });
}

function session(
  timeline: AgentTimelineEntry[],
  activeRequestId?: string,
  sessionId = 'session-1',
): AgentSession {
  return {
    sessionId,
    kind: 'chat',
    timeline,
    activeRun: activeRequestId
      ? {
          requestId: activeRequestId,
          state: 'running',
          activity: 'streaming',
        }
      : null,
  };
}

function userMessage(
  text: string,
  id = 'user-1',
): AgentTimelineEntry {
  return {
    id,
    type: 'message',
    role: 'user',
    text,
    status: 'completed',
  };
}

function assistantMessage(
  text: string,
  status: 'streaming' | 'completed',
): Extract<AgentTimelineEntry, { type: 'message' }> {
  return {
    id: 'assistant-1',
    type: 'message',
    role: 'assistant',
    requestId: 'request-1',
    text,
    status,
  };
}
