import test from 'node:test';
import assert from 'node:assert/strict';
import { definePromptTemplate } from './template';

test('prompt templates validate their declared variables at definition time', () => {
  assert.throws(() => definePromptTemplate<{ value: string }>(
    'Value: {value}',
    [],
  ));
});

test('prompt templates preserve injected schema and XML content', () => {
  const template = definePromptTemplate<{ value: string }>(
    'Value:\n{value}',
    ['value'],
  );
  const value = '<schema>{"outcome":"task_done"}</schema>';
  assert.equal(template.render({ value }), `Value:\n${value}`);
});
