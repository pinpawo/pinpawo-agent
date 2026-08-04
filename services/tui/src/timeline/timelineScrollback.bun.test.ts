import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoxRenderable,
  CliRenderEvents,
  RGBA,
  TextAttributes,
  TextRenderable,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import { buildWelcomeLines } from '../welcome/welcomeModel';
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

test('completed assistant markdown renders rich blocks without source markers', async () => {
  const setup = await createTimelineRenderer(64);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    timeline.render(session([assistantMessage([
      '# Result',
      '',
      'Use **bold** and [docs](https://example.com).',
      '',
      '- first',
      '- second',
      '',
      '> quoted',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      '| Key | Value |',
      '| --- | --- |',
      '| mode | rich |',
    ].join('\n'), 'completed')]));

    const text = setup.cellOutput.takeText();
    assert.match(text, /^\| Result/m);
    assert.match(text, /Use bold and docs \(https:\/\/example\.com\)\./);
    assert.match(text, /- first/);
    assert.match(text, /quoted/);
    assert.match(text, /code · ts/);
    assert.match(text, /const answer = 42;/);
    assert.match(text, /Key\s+Value/);
    assert.match(text, /mode\s+rich/);
    assert.doesNotMatch(text, /\*\*|```|# Result|\| ---/);

    const spans = setup.styleOutput.take().flatMap((lines) =>
      lines.flatMap((line) => line.spans)
    );
    assert.ok(spans.some((span) => (
      span.text.includes('Result')
      && (span.attributes & TextAttributes.BOLD) !== 0
    )));
    assert.ok(spans.some((span) => (
      span.text.includes('bold')
      && (span.attributes & TextAttributes.BOLD) !== 0
    )));
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('completed subagent messages render rich Markdown without an actor label', async () => {
  const setup = await createTimelineRenderer(64);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    timeline.render(session([{
      id: 'subagent-markdown',
      type: 'message',
      role: 'subagent',
      text: [
        '# Result',
        '',
        'Use **bold** and [docs](https://example.com).',
        '',
        '| Key | Value |',
        '| --- | --- |',
        '| mode | rich |',
      ].join('\n'),
      status: 'completed',
    }]));

    const text = setup.cellOutput.takeText();
    assert.match(text, /^\| Result/m);
    assert.match(text, /Use bold and docs \(https:\/\/example\.com\)\./);
    assert.match(text, /Key\s+Value/);
    assert.match(text, /mode\s+rich/);
    assert.doesNotMatch(text, /subagent|\*\*|# Result|\| ---/);
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('user messages render as a neutral full-width surface', async () => {
  const setup = await createTimelineRenderer(40);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    timeline.render(session([userMessage('hello\nsecond line')]));
    const text = setup.cellOutput.takeText();
    assert.match(text, /  hello\n  second line/);

    const spans = setup.styleOutput.take().flatMap((lines) =>
      lines.flatMap((line) => line.spans)
    );
    const messageBackground = RGBA.fromHex('#303842');
    const messageText = spans.find((span) => span.text.includes('hello'));
    assert.ok(messageText);
    assert.ok(messageText.bg.equals(messageBackground));
    assert.ok(messageText.fg.equals(RGBA.fromHex('#e7ecee')));
    assert.ok(spans.some((span) => (
      span.text.includes('hello')
      && span.bg.equals(messageBackground)
    )));
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('message timestamps align without actor labels', async () => {
  const setup = await createTimelineRenderer(64);
  const timeline = new TimelineScrollback(setup.renderer);
  const createdAt = '2026-07-15T02:00:00.000Z';
  const updatedAt = '2026-07-15T02:00:01.000Z';
  const completedAt = '2026-07-15T02:00:02.000Z';
  const entries: AgentTimelineEntry[] = [{
    ...userMessage('user message', 'user-timestamp'),
    createdAt,
  }, {
    ...assistantMessage('assistant message', 'completed'),
    id: 'assistant-timestamp',
    updatedAt,
  }, {
    id: 'subagent-timestamp',
    type: 'message',
    role: 'subagent',
    text: 'worker message',
    status: 'completed',
    createdAt: completedAt,
  }];
  try {
    timeline.render(session(entries));
    const text = setup.cellOutput.takeText();
    const headers = entries.map((entry) => (
      formatTimelineEntry(entry).split('\n')[0]
    ));
    const rows = text.split('\n').filter((row) => headers.includes(row));

    assert.deepEqual(rows, headers);
    assert.doesNotMatch(text, /\b(?:PinPawo|subagent)\b|你/);
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('streaming markdown keeps a mutable table out of committed scrollback', async () => {
  const setup = await createTimelineRenderer(48);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const streaming = assistantMessage([
      '| Key | Value |',
      '| --- | --- |',
      '| mode | initial |',
    ].join('\n'), 'streaming');
    timeline.render(session([streaming], 'request-1'));
    assert.equal(setup.cellOutput.takeText(), '');

    const grown = {
      ...streaming,
      text: `${streaming.text}\n| detail | a wider value |`,
    };
    timeline.render(session([grown], 'request-1'));
    assert.equal(setup.cellOutput.takeText(), '');

    timeline.render(session([{
      ...grown,
      status: 'completed' as const,
    }]));
    const completed = setup.cellOutput.takeText();
    assert.match(completed, /Key\s+Value/);
    assert.match(completed, /mode\s+initial/);
    assert.match(completed, /detail\s+a wider value/);
    assert.doesNotMatch(completed, /^PinPawo$/m);
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
    assert.equal(
      setup.externalOutput.takeText(),
      ['paw', 'PinPawo TUI v2'].join('\n'),
    );
    setup.cellOutput.clear();

    timeline.render(session([userMessage('hello')]));
    assert.equal(
      setup.cellOutput.takeText(),
      `${formatUserMessageSurface(userMessage('hello'))}\n`,
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('welcome paints solid raster cells without font line-height seams', async () => {
  const setup = await createTimelineRenderer(20);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    timeline.renderWelcome(['█ paw']);
    assert.equal(setup.cellOutput.takeText(), '  paw');

    const spans = setup.styleOutput.take().flatMap((lines) =>
      lines.flatMap((line) => line.spans)
    );
    const solidCell = spans.find((span) => span.text === ' ');
    assert.ok(solidCell);
    assert.ok(solidCell.bg.equals(RGBA.fromHex('#69c0c8')));
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('welcome uses visual hierarchy for identity, metadata, and shortcuts', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    timeline.renderWelcome(buildWelcomeLines({
      session: session([]),
      width: 80,
      connection: 'connected',
      hostMetadata: {
        localAgentVersion: '0.2.0',
        capabilities: ['general'],
      },
    }));
    const text = setup.cellOutput.takeText();
    assert.match(text, /PinPawo TUI v2/);

    const spans = setup.styleOutput.take().flatMap((lines) =>
      lines.flatMap((line) => line.spans)
    );
    const title = spans.find((span) => (
      span.fg.equals(RGBA.fromHex('#efa6ca'))
      && (span.attributes & TextAttributes.BOLD) !== 0
    ));
    const status = spans.find((span) =>
      span.fg.equals(RGBA.fromHex('#7fcf9b'))
    );
    const muted = spans.filter((span) => (
      span.fg.equals(RGBA.fromHex('#789da3'))
      && (span.attributes & TextAttributes.DIM) !== 0
    ));
    assert.ok(title);
    assert.ok(status);
    assert.ok(muted.length >= 3);
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('an empty subagent entry is ignored without blocking later timeline rows', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const emptySubagent: AgentTimelineEntry = {
      id: 'subagent-empty',
      type: 'message',
      role: 'subagent',
      text: ' \n ',
      status: 'completed',
    };
    timeline.render(session([emptySubagent]));
    assert.deepEqual(setup.externalOutput.take(), []);
    setup.cellOutput.clear();

    const next = userMessage('continue', 'user-after-empty');
    timeline.render(session([emptySubagent, next]));
    assert.equal(
      setup.cellOutput.takeText(),
      `${formatUserMessageSurface(next)}\n`,
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('a running operation gets a live surface without committing later rows out of order', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const user = userMessage('inspect');
    timeline.render(session([user], 'request-1'));
    setup.externalOutput.clear();
    setup.cellOutput.clear();
    let surfaceCount = 0;
    const liveSurfaces: ReturnType<
      typeof setup.renderer.createScrollbackSurface
    >[] = [];
    const createScrollbackSurface = setup.renderer.createScrollbackSurface.bind(
      setup.renderer,
    );
    setup.renderer.createScrollbackSurface = (options) => {
      surfaceCount += 1;
      const surface = createScrollbackSurface(options);
      liveSurfaces.push(surface);
      return surface;
    };

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
    assert.equal(surfaceCount, 1);
    assert.deepEqual(setup.externalOutput.take(), []);
    const liveRoot = liveSurfaces[0]?.root.getRenderable(
      'timeline-live-operation-1',
    );
    assert.ok(liveRoot instanceof BoxRenderable);
    const [operationLine, subagentMarkdown, spacer] = liveRoot.getChildren();
    assert.ok(operationLine instanceof TextRenderable);
    assert.equal(operationLine.plainText, formatTimelineEntry(operation));
    assert.ok(subagentMarkdown instanceof BoxRenderable);
    assert.ok(spacer instanceof TextRenderable);
    assert.equal(spacer.plainText, ' ');

    const completedOperation = {
      ...operation,
      phase: 'completed' as const,
    };
    timeline.render(session([user, completedOperation, subagent]));
    assert.equal(
      setup.cellOutput.takeText(),
      [
        formatTimelineEntry(completedOperation),
        '',
        '| found evidence',
        '',
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
        MAX_SETTLED_ENTRIES_PER_COMMIT * 4,
        MAX_SETTLED_ENTRIES_PER_COMMIT * 4,
        4,
      ],
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

test('a new submitted turn commits its user row after prior history', async () => {
  const setup = await createTimelineRenderer(80);
  const timeline = new TimelineScrollback(setup.renderer);
  try {
    const first = userMessage('first', 'user-1');
    timeline.render(session([first]));
    setup.externalOutput.clear();
    setup.cellOutput.clear();

    const second = userMessage('second', 'user-2');
    timeline.render(session([first, second], 'request-2'));
    assert.equal(
      setup.cellOutput.takeText(),
      `${formatUserMessageSurface(second)}\n`,
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
    setup.cellOutput.clear();

    timeline.render(session([], undefined, 'session-new'));
    assert.match(setup.cellOutput.takeText(), /session session-new/);

    timeline.render(session([
      userMessage('same text', 'new-user'),
    ], undefined, 'session-new'));
    assert.equal(
      setup.cellOutput.takeText(),
      `${formatUserMessageSurface(repeated)}\n`,
    );
  } finally {
    timeline.destroy();
    setup.renderer.destroy();
  }
});

async function createTimelineRenderer(width: number) {
  const setup = await createTestRenderer({
    width,
    height: 24,
    screenMode: 'split-footer',
    footerHeight: 9,
    externalOutputMode: 'capture-stdout',
  });
  const commits: string[][] = [];
  const styleCommits: ReturnType<
    typeof setup.renderer.currentRenderBuffer.getSpanLines
  >[] = [];
  const decoder = new TextDecoder();
  setup.renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, (event) => {
    // OpenTUI 0.4.5's stock recorder slices a UTF-8 byte stream by terminal
    // cell width, which shifts rows after CJK characters. Ask the native
    // buffer to emit explicit row breaks for Unicode-sensitive assertions.
    commits.push(
      decoder.decode(event.snapshot.getRealCharBytes(true))
        .split('\n')
        .slice(0, event.snapshot.height)
        .map((line) => line.trimEnd()),
    );
    styleCommits.push(event.snapshot.getSpanLines());
  });
  return {
    ...setup,
    cellOutput: {
      takeText() {
        const text = commits.flat().join('\n');
        commits.length = 0;
        return text;
      },
      clear() {
        commits.length = 0;
      },
    },
    styleOutput: {
      take() {
        const output = [...styleCommits];
        styleCommits.length = 0;
        return output;
      },
      clear() {
        styleCommits.length = 0;
      },
    },
  };
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
): Extract<AgentTimelineEntry, { type: 'message' }> {
  return {
    id,
    type: 'message',
    role: 'user',
    text,
    status: 'completed',
  };
}

function formatUserMessageSurface(entry: AgentTimelineEntry): string {
  return `\n${formatTimelineEntry(entry)}\n`;
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
