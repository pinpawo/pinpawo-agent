import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAccessibilitySnapshot,
  buildSnapshotExpression,
  originOf,
} from './snapshot.js';

test('origin guard accepts only http and https origins', () => {
  assert.equal(originOf('https://example.com/path'), 'https://example.com');
  assert.equal(originOf('http://localhost:3000/'), 'http://localhost:3000');
  assert.throws(() => originOf('chrome://settings'), /unsupported page protocol/);
});

test('runtime snapshot expression carries numbered interactive hints', () => {
  const expression = buildSnapshotExpression(17);
  assert.doesNotThrow(() => new Function(`return ${expression}`));
  assert.match(expression, /maxInteractive = 17/);
  assert.match(expression, /'\[' \+ index \+ '\] '/);
  assert.match(expression, /interactiveCount: candidates\.length/);
  assert.match(expression, /textLength: bodyText\.length/);
});

test('accessibility fallback returns a raw backend snapshot', () => {
  const result = buildAccessibilitySnapshot([
    { role: { value: 'RootWebArea' }, name: { value: 'Page title' } },
    { role: { value: 'StaticText' }, name: { value: 'Readable text' } },
    { role: { value: 'button' }, name: { value: 'Continue' }, backendDOMNodeId: 9 },
  ], 'https://example.com/');

  assert.equal(result.title, 'Page title');
  assert.equal(result.text, 'Readable text');
  assert.equal(result.textSource, 'Accessibility.getFullAXTree');
  assert.equal(result.interactive[0].index, 1);
  assert.equal(result.interactive[0].backendNodeId, 9);
});
