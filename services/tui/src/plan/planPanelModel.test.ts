import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCurrentPlanPanel } from './planPanelModel';

const plan = {
  items: [
    { id: '1', capability: 'general', task: 'Understand request', status: 'completed' as const },
    { id: '2', capability: 'explore', task: 'Inspect code', status: 'active' as const },
    { id: '3', capability: 'browser', task: 'Verify result', status: 'pending' as const },
  ],
};

test('builds an expanded current plan when terminal space allows', () => {
  assert.deepEqual(buildCurrentPlanPanel(plan, { width: 100, terminalHeight: 40 }), {
    content: [
      '当前计划 · 1/3',
      '  ✓ general · Understand request',
      '  → explore · Inspect code',
      '  · browser · Verify result',
    ].join('\n'),
    height: 4,
    mode: 'expanded',
  });
});

test('compacts the plan for overlays and short terminals', () => {
  const panel = buildCurrentPlanPanel(plan, {
    width: 100,
    terminalHeight: 20,
    overlayOpen: true,
  });
  assert.equal(panel.mode, 'compact');
  assert.equal(panel.height, 1);
  assert.match(panel.content, /^计划 1\/3 · → explore/);
});

test('hides the panel after the canonical plan is cleared', () => {
  assert.deepEqual(buildCurrentPlanPanel(null, { width: 100, terminalHeight: 40 }), {
    content: '',
    height: 0,
    mode: 'hidden',
  });
});
