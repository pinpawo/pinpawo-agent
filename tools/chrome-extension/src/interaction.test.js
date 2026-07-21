import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExtractExpression,
  buildResolveTargetExpression,
  normalizeElementTarget,
  normalizeHumanization,
  randomDelayMs,
} from './interaction.js';

test('element targets require exactly one bounded ref or selector', () => {
  assert.deepEqual(normalizeElementTarget({ ref: 'snapshot:1' }), { ref: 'snapshot:1' });
  assert.deepEqual(normalizeElementTarget({ selector: '#submit' }), { selector: '#submit' });
  assert.throws(() => normalizeElementTarget({}), /exactly one/);
  assert.throws(() => normalizeElementTarget({ ref: 'a', selector: '#a' }), /exactly one/);
});

test('target and extract expressions are syntactically valid and JSON-escaped', () => {
  const target = buildResolveTargetExpression({ selector: '[aria-label="a\\b"]' });
  const extract = buildExtractExpression('#article', 12, 500);
  assert.doesNotThrow(() => new Function(`return ${target}`));
  assert.doesNotThrow(() => new Function(`return ${extract}`));
  assert.match(target, /stale_element_reference/);
  assert.match(extract, /sourceText\.slice/);
});

test('humanization hooks clamp defaults and produce bounded delays', () => {
  assert.deepEqual(normalizeHumanization({ preDelayMinMs: 200, preDelayMaxMs: 50 }), {
    preDelayMinMs: 50,
    preDelayMaxMs: 200,
    hoverMinMs: 60,
    hoverMaxMs: 180,
    keyDelayMinMs: 25,
    keyDelayMaxMs: 70,
  });
  assert.equal(randomDelayMs(10, 20, () => 0), 10);
  assert.equal(randomDelayMs(10, 20, () => 0.999), 20);
});
