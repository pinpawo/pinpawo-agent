import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxRenderable, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { FileMentionView } from './fileMentionView';

test('file mention candidates stay inside the fixed footer across resize', async (context) => {
  const setup = await createTestRenderer({
    width: 60,
    height: 24,
    screenMode: 'split-footer',
    footerHeight: 9,
  });
  context.after(() => setup.renderer.destroy());
  const root = new BoxRenderable(setup.renderer, {
    width: '100%',
    height: '100%',
    backgroundColor: RGBA.defaultBackground(),
  });
  const view = new FileMentionView(setup.renderer);
  root.add(view.frame);
  setup.renderer.root.add(root);

  const state = {
    phase: 'open' as const,
    query: 'docs/',
    replacementStart: 4,
    replacementEnd: 10,
    selectedIndex: 1,
    items: [
      { path: 'docs/reference/', type: 'directory' as const },
      { path: 'docs/TUI.md', type: 'file' as const },
    ],
  };
  view.render(state, 60);
  await setup.flush();
  const initial = setup.captureCharFrame();
  assert.match(initial, /Files · @docs\//);
  assert.match(initial, /docs\/TUI\.md/);
  assert.equal(frameRows(initial).length, 9);

  setup.resize(28, 18);
  view.render(state, 28);
  await setup.flush();
  const resized = setup.captureCharFrame();
  assert.match(resized, /Files · @docs\//);
  assert.equal(frameRows(resized).length, 9);
  assert.ok(frameRows(resized).every((line) => line.length <= 28), resized);
});

function frameRows(frame: string) {
  const rows = frame.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
}
