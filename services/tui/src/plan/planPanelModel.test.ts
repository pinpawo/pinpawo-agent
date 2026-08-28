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
      '当前计划 · 2/3',
      '  ✓ general · Understand request',
      '  → explore · Inspect code',
      '  · browser · Verify result',
    ].join('\n'),
    height: 4,
    mode: 'expanded',
  });
});

test('keeps other plan items visible on short terminals', () => {
  const panel = buildCurrentPlanPanel(plan, {
    width: 100,
    terminalHeight: 20,
  });
  assert.equal(panel.mode, 'expanded');
  assert.equal(panel.height, 4);
  assert.match(panel.content, /Understand request/);
  assert.match(panel.content, /Inspect code/);
  assert.match(panel.content, /Verify result/);
});

test('temporarily compacts the plan while an overlay is open', () => {
  const panel = buildCurrentPlanPanel(plan, {
    width: 100,
    terminalHeight: 40,
    overlayOpen: true,
  });
  assert.equal(panel.mode, 'compact');
  assert.equal(panel.height, 1);
  assert.match(panel.content, /^计划 2\/3 · → explore/);
});

test('keeps the plan visible between delegations when no item is active', () => {
  const betweenSteps = {
    items: [
      { id: '1', capability: 'general', task: 'Understand request', status: 'completed' as const },
      { id: '2', capability: 'explore', task: 'Inspect code', status: 'pending' as const },
    ],
  };
  const panel = buildCurrentPlanPanel(betweenSteps, { width: 100, terminalHeight: 40 });
  assert.equal(panel.mode, 'expanded');
  assert.match(panel.content, /当前计划 · 2\/2/);
  assert.match(panel.content, /Inspect code/);
});

test('shows the first active task as step one instead of zero completed', () => {
  const startingPlan = {
    items: [
      { id: '1', capability: 'general', task: 'Start work', status: 'active' as const },
      { id: '2', capability: 'browser', task: 'Verify work', status: 'pending' as const },
    ],
  };

  const expanded = buildCurrentPlanPanel(startingPlan, {
    width: 100,
    terminalHeight: 40,
  });
  const compact = buildCurrentPlanPanel(startingPlan, {
    width: 100,
    terminalHeight: 20,
    overlayOpen: true,
  });

  assert.match(expanded.content, /^当前计划 · 1\/2/);
  assert.match(compact.content, /^计划 1\/2/);
});

test('wraps complete plan tasks instead of truncating them', () => {
  const detailedPlan = {
    items: [
      {
        id: '1',
        capability: 'general',
        task: 'Inspect the complete implementation without losing any details',
        status: 'active' as const,
      },
      {
        id: '2',
        capability: 'browser',
        task: 'Verify the final result in the running application',
        status: 'pending' as const,
      },
    ],
  };

  const panel = buildCurrentPlanPanel(detailedPlan, {
    width: 32,
    terminalHeight: 20,
  });

  assert.equal(panel.mode, 'expanded');
  assert.ok(panel.height > 3);
  assert.doesNotMatch(panel.content, /…/);
  assert.match(panel.content, /losing any/);
  assert.match(panel.content, /details/);
  assert.match(panel.content, /runni\s+ng/);
  assert.match(panel.content, /application/);
});

test('a taller terminal reveals more of a long plan', () => {
  const longPlan = {
    items: Array.from({ length: 9 }, (_, index) => ({
      id: String(index + 1),
      capability: 'general',
      task: `Step ${index + 1}`,
      status: index === 0 ? ('active' as const) : ('pending' as const),
    })),
  };
  const short = buildCurrentPlanPanel(longPlan, { width: 100, terminalHeight: 24 });
  const tall = buildCurrentPlanPanel(longPlan, { width: 100, terminalHeight: 60 });
  assert.ok(tall.height > short.height, `${tall.height} should exceed ${short.height}`);
  assert.match(short.content, /还有 \d+ 项/);
  assert.doesNotMatch(tall.content, /还有 \d+ 项/);
});

test('hides the panel after the canonical plan is cleared', () => {
  assert.deepEqual(buildCurrentPlanPanel(null, { width: 100, terminalHeight: 40 }), {
    content: '',
    height: 0,
    mode: 'hidden',
  });
});
