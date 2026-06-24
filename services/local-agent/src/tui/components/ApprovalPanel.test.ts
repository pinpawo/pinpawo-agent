import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';
import { ApprovalPanel } from './ApprovalPanel';

test('ApprovalPanel renders apply_patch review details as patch preview', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/example.ts',
    '@@',
    '-const value = 1;',
    '+const value = 2;',
    '*** End Patch',
  ].join('\n');
  const details = {
    files: [{ path: 'src/example.ts', type: 'update' }],
    patch,
  };
  const element = ApprovalPanel({
    review: {
      id: 'review-1',
      schemaVersion: 1,
      view: {
        kind: 'plain',
        title: '应用补丁',
        body: [
          'Summary: update',
          '',
          'Target: src/example.ts',
          '',
          `Details:\n${JSON.stringify(details, null, 2)}`,
        ].join('\n'),
      },
      options: [],
    },
    width: 100,
    selectedIndex: 0,
  });

  const text = collectText(element).join('\n');
  assert.match(text, /Summary: update/);
  assert.match(text, /Target: src\/example\.ts/);
  assert.match(text, /  patch src\/example\.ts/);
  assert.match(text, /  -const value = 1;/);
  assert.match(text, /  \+const value = 2;/);
  assert.doesNotMatch(text, /"patch":/);
});

function collectText(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    return [String(node)];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectText);
  }
  if (!isValidElement(node)) {
    return [];
  }
  return collectText((node.props as { children?: unknown }).children);
}
