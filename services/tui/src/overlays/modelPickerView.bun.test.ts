import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxRenderable, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import {
  beginModelSelection,
  loadModelPickerProfiles,
} from './modelPickerModel';
import { ModelPickerView } from './modelPickerView';

test('model picker stays bounded while showing modality compatibility', async (context) => {
  const setup = await createTestRenderer({
    width: 64,
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
  const view = new ModelPickerView(setup.renderer);
  root.add(view.frame);
  setup.renderer.root.add(root);

  let state = loadModelPickerProfiles({
    sessionId: 'session-1',
    defaultProfileId: 'vision',
    selectedProfileId: 'vision',
    requiredInputModalities: ['text', 'image'],
    profiles: [{
      id: 'vision',
      label: 'Vision',
      provider: 'openai',
      model: 'vision-model',
      inputModalities: ['text', 'image'],
      available: true,
      compatible: true,
      issues: [],
    }],
  });
  view.render(state, 64);
  await setup.flush();
  const initial = setup.captureCharFrame();
  assert.match(initial, /Session model/);
  assert.match(initial, /text \+ image/);
  assert.match(initial, /current · default · image/);
  assert.equal(frameRows(initial).length, 9);

  state = beginModelSelection(state);
  setup.resize(36, 18);
  view.render(state, 36);
  await setup.flush();
  const resized = setup.captureCharFrame();
  assert.match(resized, /switching/);
  assert.match(resized, /Switching to Vision/);
  assert.equal(frameRows(resized).length, 9);
  assert.ok(frameRows(resized).every((line) => line.length <= 36), resized);
});

function frameRows(frame: string) {
  const rows = frame.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
}
