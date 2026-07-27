import assert from 'node:assert/strict';
import test from 'node:test';
import { BoxRenderable, RGBA } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import {
  beginPolicySave,
  createPolicyPickerState,
  movePolicySelection,
  openPolicyPicker,
} from './policyPickerModel';
import { PolicyPickerView } from './policyPickerView';

test('policy picker stays inside the fixed footer across selection and resize', async (context) => {
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
  const view = new PolicyPickerView(setup.renderer);
  root.add(view.frame);
  setup.renderer.root.add(root);

  let state = openPolicyPicker(
    createPolicyPickerState(),
    'require_authorization',
  );
  view.render(state, 60);
  await setup.flush();
  const initial = setup.captureCharFrame();
  assert.match(initial, /Review policy/);
  assert.match(initial, /Ask every time/);
  assert.match(initial, /current/);
  assert.equal(frameRows(initial).length, 9);

  state = beginPolicySave(movePolicySelection(state, 1));
  setup.resize(32, 18);
  view.render(state, 32);
  await setup.flush();
  const resized = setup.captureCharFrame();
  assert.match(resized, /saving/);
  assert.match(resized, /Saving Auto authorize/);
  assert.equal(frameRows(resized).length, 9);
  assert.ok(frameRows(resized).every((line) => line.length <= 32), resized);
});

function frameRows(frame: string) {
  const rows = frame.split('\n');
  if (rows.at(-1) === '') rows.pop();
  return rows;
}
