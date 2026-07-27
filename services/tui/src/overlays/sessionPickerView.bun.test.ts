import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxRenderable, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import type { AgentSessionSummary } from '@pinpawo/agent-session';
import {
  loadSessionPickerSessions,
  moveSessionPickerSelection,
} from './sessionPickerModel';
import { SessionPickerView } from './sessionPickerView';

test('session picker stays inside the split footer across selection and resize', async (context) => {
  const setup = await createTestRenderer({
    width: 60,
    height: 24,
    screenMode: 'split-footer',
    footerHeight: 8,
  });
  context.after(() => setup.renderer.destroy());
  const root = new BoxRenderable(setup.renderer, {
    width: '100%',
    height: '100%',
    backgroundColor: RGBA.defaultBackground(),
  });
  const view = new SessionPickerView(setup.renderer);
  root.add(view.frame);
  setup.renderer.root.add(root);

  let state = loadSessionPickerSessions(createSessions(8));
  view.render(state, 60);
  await setup.flush();
  const initial = setup.captureCharFrame();
  assert.match(initial, /Resume session/);
  assert.match(initial, /中文会话 2/);
  assert.match(initial, /PgUp\/PgDn/);
  assert.equal(frameRows(initial).length, 8);

  state = moveSessionPickerSelection(state, 6);
  setup.resize(34, 18);
  view.render(state, 34);
  await setup.flush();
  const resized = setup.captureCharFrame();
  assert.match(resized, /中文会话 8/);
  assert.equal(frameRows(resized).length, 8);
  assert.ok(
    frameRows(resized).every((line) => line.length <= 34),
    resized,
  );
});

function createSessions(count: number): AgentSessionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index + 1}`,
    kind: 'chat',
    title: `中文会话 ${index + 1}`,
    messageCount: index + 1,
    createdAt: '2026-07-27T01:00:00.000Z',
    updatedAt: '2026-07-27T02:00:00.000Z',
    active: index === 0,
  }));
}

function frameRows(frame: string) {
  const rows = frame.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
}
