import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSnapshotApprovedOrigin,
  buildDomTreeSnapshot,
  buildSensitiveInputsExpression,
  buildSnapshotExpression,
  originOf,
} from './snapshot.js';

test('origin guard accepts only http and https origins', () => {
  assert.equal(originOf('https://example.com/path'), 'https://example.com');
  assert.equal(originOf('http://localhost:3000/'), 'http://localhost:3000');
  assert.throws(() => originOf('chrome://settings'), /unsupported page protocol/);
});

test('snapshot origin guard rejects missing, invalid and cross-origin URLs', () => {
  const snapshot = { url: 'https://example.com/page' };
  assert.equal(assertSnapshotApprovedOrigin(snapshot, 'https://example.com'), snapshot);
  assert.throws(
    () => assertSnapshotApprovedOrigin(snapshot, 'https://other.example'),
    /does not match/,
  );
  assert.throws(
    () => assertSnapshotApprovedOrigin({}, 'https://example.com'),
    /unavailable/,
  );
  assert.throws(
    () => assertSnapshotApprovedOrigin({ url: 'chrome://settings' }, 'https://example.com'),
    /unsupported page protocol/,
  );
});

test('runtime snapshot expression carries numbered interactive hints', () => {
  const expression = buildSnapshotExpression(17);
  assert.doesNotThrow(() => new Function(`return ${expression}`));
  assert.match(expression, /maxInteractive = 17/);
  assert.match(expression, /'\[' \+ index \+ '\] '/);
  assert.match(expression, /interactiveCount: candidates\.length/);
  assert.match(expression, /textLength: bodyText\.length/);
  assert.match(expression, /elementRegistry\.set\(ref, element\)/);
  assert.match(expression, /ref,/);
  assert.match(expression, /current-password/);
  assert.match(expression, /one-time-code/);
  assert.match(expression, /cc-number/);
  assert.match(expression, /\[redacted\]/);
  assert.doesNotMatch(expression, /element\.textContent \|\| element\.value/);
});

test('the DOM fallback renders in the accessibility snapshot shape (#873)', () => {
  const result = buildDomTreeSnapshot({
    title: 'Page title',
    url: 'https://example.com/',
    text: 'Readable   text',
    textLength: 40,
    interactive: [
      { index: 1, ref: 'snap:1', tag: 'button', text: 'Continue', placeholder: null, hint: '[1] text=Continue' },
      { index: 2, ref: 'snap:2', tag: 'input', text: '', placeholder: 'Email', hint: '[2] input' },
    ],
  });

  assert.equal(result.source, 'dom');
  assert.equal(result.title, 'Page title');
  assert.equal(result.tree, [
    '- text: "Readable text"',
    '- button "Continue" [ref=snap:1]',
    '- input "Email" [ref=snap:2]',
  ].join('\n'));
  assert.equal(result.refCount, 2);
  // The text the page bounded before IPC still counts toward the full length.
  assert.equal(result.treeLength, result.tree.length + 40 - 'Readable   text'.length);
});

test('sensitive inputs are found through open shadow roots with the shared predicate (#873)', () => {
  const expression = buildSensitiveInputsExpression();
  assert.match(expression, /isSensitiveInput\(element\)/);
  assert.match(expression, /element\.shadowRoot/);
  assert.match(expression, /current-password/);
  assert.match(expression, /cc-number/);
  assert.doesNotThrow(() => new Function(`return ${expression}`));
});
