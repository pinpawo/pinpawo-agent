import assert from 'node:assert/strict';
import React from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { KanbanFlow } from '../src/App';

test('task cards render the new snapshot and show an undirected relationship from both ends', () => {
  const tasks = ['Alpha', 'Beta'].map((title) => ({
    taskId: title, title, detail: 'Task detail', status: 'todo' as const,
    createdAt: '', updatedAt: '',
  }));
  const markup = renderToStaticMarkup(<KanbanFlow
    tasks={tasks}
    relationships={[{ sourceTaskId: 'Alpha', targetTaskId: 'Beta', type: 'related' }]}
    pets={[{ petId: 'worker', name: 'Worker' }]}
    onAssign={() => undefined}
    assigningTaskId=""
  />);
  assert.equal((markup.match(/RELATED TASKS/g) ?? []).length, 2);
  assert.ok(markup.includes('title="Beta">Beta</code>'));
  assert.ok(markup.includes('title="Alpha">Alpha</code>'));
  assert.equal((markup.match(/<button/g) ?? []).length, 2);
  assert.ok(!markup.includes('disabled'));
});
