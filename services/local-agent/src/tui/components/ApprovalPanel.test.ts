import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';
import { ApprovalPanel } from './ApprovalPanel';

test('ApprovalPanel renders a diff review through the patch preview', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/example.ts',
    '@@',
    '-const value = 1;',
    '+const value = 2;',
    '*** End Patch',
  ].join('\n');
  const element = ApprovalPanel({
    review: {
      interactionId: 'review-1',
      schemaVersion: 2,
      view: {
        kind: 'diff',
        title: '应用补丁',
        summary: 'update',
        target: 'src/example.ts',
        patch,
      },
      options: [],
    },
    width: 100,
    selectedIndex: 0,
    reviewIndex: 0,
    reviewCount: 1,
  });

  const text = collectText(element).join('\n');
  assert.match(text, /update/);
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
