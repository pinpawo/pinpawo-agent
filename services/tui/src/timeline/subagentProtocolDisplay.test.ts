import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSubagentProtocolMessage } from './subagentProtocolDisplay';

test('formats a canonical initial delegation briefing for the timeline', () => {
  assert.equal(
    formatSubagentProtocolMessage([
      '<delegation_briefing role="task_boundary" source="orchestrator" mode="initial">',
      '  <task>',
      '  <![CDATA[',
      'Review the current pull request.',
      '  ]]>',
      '  </task>',
      '  <essential_context>',
      '  <![CDATA[',
      'Preserve the existing main behavior.',
      '  ]]>',
      '  </essential_context>',
      '</delegation_briefing>',
    ].join('\n')),
    [
      '**Delegating**',
      '',
      'Review the current pull request.',
      '',
      '**Context**',
      '',
      'Preserve the existing main behavior.',
    ].join('\n'),
  );
});

test('formats a continuation briefing and decodes split CDATA', () => {
  assert.equal(
    formatSubagentProtocolMessage([
      '<delegation_briefing role="task_boundary" source="orchestrator" mode="continue">',
      '<task><![CDATA[Handle ]]]]><![CDATA[> safely.]]></task>',
      '<gap_note><![CDATA[Resume after the failed check.]]></gap_note>',
      '</delegation_briefing>',
    ].join('\n')),
    [
      '**Delegating · continuing**',
      '',
      'Handle ]]> safely.',
      '',
      '**Context**',
      '',
      'Resume after the failed check.',
    ].join('\n'),
  );
});

test('formats a canonical artifact discovery context compactly', () => {
  assert.equal(
    formatSubagentProtocolMessage([
      '<artifact_discovery_context role="fact" source="runtime" trust="non_authoritative">',
      '  <scope>current_thread</scope>',
      '</artifact_discovery_context>',
    ].join('\n')),
    'Artifact context · current_thread',
  );
});

test('leaves ordinary subagent XML untouched', () => {
  assert.equal(
    formatSubagentProtocolMessage('<delegation_briefing mode="initial"><task>model text</task></delegation_briefing>'),
    null,
  );
});
