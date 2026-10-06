import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { AgentSession, AgentTimelineEntry } from '@pinpawo/agent-session';
import { MessageViewer } from './messageViewer';

function session(timeline: AgentTimelineEntry[]): AgentSession {
  return { sessionId: 'viewer-test', kind: 'chat', timeline, activeRun: null, pendingInterrupt: null };
}
function message(id: string, text: string): Extract<AgentTimelineEntry, { type: 'message' }> {
  return { id, type: 'message', role: 'assistant', text, status: 'completed' };
}
for (const [width, height] of [[100, 30], [32, 8], [20, 4]]) {
  test(`message viewer preserves list position and Markdown at ${width}x${height}`, async () => {
    const setup = await createTestRenderer({ width, height });
    const messages = Array.from({ length: 40 }, (_, index) => message(String(index), `Message ${index}`));
    messages[38] = message('long', '# Heading\n\n**bold**\n\n```ts\nconst value = 1;\n```\n\n' + Array.from({ length: 80 }, (_, i) => `paragraph ${i}\n\n`).join(''));
    const view = new MessageViewer(setup.renderer, session(messages));
    setup.renderer.root.add(view.frame);
    try {
      await setup.flush();
      view.handleKey({ name: 'up' });
      await setup.flush();
      const listTop = view.list.scrollTop;
      view.handleKey({ name: 'return' });
      await setup.flush();
      assert.match(setup.captureCharFrame(), /Heading/);
      assert.doesNotMatch(setup.captureCharFrame(), /# Heading/);
      if (height === 30) assert.match(setup.captureCharFrame(), /const value = 1;/);
      view.handleKey({ name: 'pagedown' });
      await setup.flush();
      assert.ok(view.reader.scrollTop > 0);
      setup.resize(Math.max(16, width - 4), Math.max(4, height - 2));
      await setup.flush();
      view.handleKey({ name: 'end' });
      await setup.flush();
      assert.match(setup.captureCharFrame(), /paragraph 79/);
      setup.resize(width, height);
      await setup.flush();
      assert.equal(view.handleKey({ name: 'escape' }), false);
      await setup.flush();
      assert.equal(view.list.scrollTop, listTop);
      for (let i = 0; i < 3; i++) {
        view.handleKey({ name: 'return' });
        await setup.flush();
        assert.equal(view.reader.scrollTop, 0);
        view.handleKey({ name: 'escape' });
        await setup.flush();
        assert.equal(view.list.scrollTop, listTop);
      }
      view.handleKey({ name: 'down' });
      view.handleKey({ name: 'return' });
      await setup.flush();
      assert.match(setup.captureCharFrame(), /Message 39/);
      view.handleKey({ name: 'escape' });
      assert.equal(view.handleKey({ name: 'escape' }), true);
    } finally { setup.renderer.destroy(); view.destroy(); }
  });
}
test('viewer snapshots streaming text and excludes private subagent messages', async () => {
  const setup = await createTestRenderer({ width: 80, height: 16 });
  const streaming = { ...message('live', 'Partial response'), status: 'streaming' as const };
  const view = new MessageViewer(setup.renderer, session([
    streaming, { ...message('child', 'PRIVATE'), role: 'subagent' },
  ]));
  setup.renderer.root.add(view.frame);
  try {
    streaming.text = 'Changed after opening';
    view.handleKey({ name: 'return' });
    await setup.flush();
    assert.match(setup.captureCharFrame(), /Partial response/);
    assert.doesNotMatch(setup.captureCharFrame(), /Changed|PRIVATE/);
    assert.equal(view.handleKey({ name: 'escape' }), false);
    assert.equal(view.handleKey({ name: 'escape' }), true);
  } finally { setup.renderer.destroy(); view.destroy(); }
});

test('empty viewer consumes navigation without opening a reader', async () => {
  const setup = await createTestRenderer({ width: 40, height: 6 });
  const view = new MessageViewer(setup.renderer, session([]));
  setup.renderer.root.add(view.frame);
  try {
    for (const name of ['up', 'down', 'home', 'end', 'return']) {
      assert.equal(view.handleKey({ name }), false);
    }
    await setup.flush();
    assert.match(setup.captureCharFrame(), /no messages yet/);
    assert.equal(view.reader.visible, false);
    assert.equal(view.handleKey({ name: 'escape' }), true);
  } finally { setup.renderer.destroy(); view.destroy(); }
});
