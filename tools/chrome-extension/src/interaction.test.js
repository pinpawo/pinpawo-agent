import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExtractExpression,
  buildResolveTargetExpression,
  chunkTrustedInsertText,
  createSerialExecutor,
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

test('extension work is serialized and a rejection does not block the queue', async () => {
  const enqueue = createSerialExecutor();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueue(async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:end');
    throw new Error('expected failure');
  });
  const second = enqueue(async () => {
    events.push('second');
    return 'done';
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  releaseFirst();
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, 'done');
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});

test('trusted insertion chunks long text without splitting Unicode code points', () => {
  const text = `${'a'.repeat(2_001)}🙂${'b'.repeat(2_000)}`;
  const chunks = chunkTrustedInsertText(text);

  assert.deepEqual(chunks.map((chunk) => Array.from(chunk).length), [2_000, 2_000, 2]);
  assert.equal(chunks.join(''), text);
});
