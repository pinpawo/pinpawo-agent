import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSubagentProtocolMessage } from './subagentProtocolDisplay';

test('formats a canonical delegation briefing for the timeline', () => {
  assert.equal(
    formatSubagentProtocolMessage([
      '<delegation_briefing role="task_boundary" source="orchestrator">',
      '  <run_user_request role="goal_context" source="orchestrator_state" trust="read_only">',
      '    <request><![CDATA[Review the pull request and explain the architecture.]]></request>',
      '  </run_user_request>',
      '  <task>',
      '  <![CDATA[',
      'Review the current pull request.',
      '  ]]>',
      '  </task>',
      '  <briefing>',
      '  <![CDATA[',
      'Preserve the existing main behavior.',
      '  ]]>',
      '  </briefing>',
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

test('formats a briefing and decodes split CDATA', () => {
  assert.equal(
    formatSubagentProtocolMessage([
      '<delegation_briefing role="task_boundary" source="orchestrator">',
      '<task><![CDATA[Handle ]]]]><![CDATA[> safely.]]></task>',
      '<briefing><![CDATA[Resume after the failed check.]]></briefing>',
      '</delegation_briefing>',
    ].join('\n')),
    [
      '**Delegating**',
      '',
      'Handle ]]> safely.',
      '',
      '**Context**',
      '',
      'Resume after the failed check.',
    ].join('\n'),
  );
});

test('ignores tag-shaped text inside the nested run request', () => {
  assert.equal(
    formatSubagentProtocolMessage([
      '<delegation_briefing role="task_boundary" source="orchestrator">',
      '  <run_user_request role="goal_context" source="orchestrator_state" trust="read_only">',
      '    <request><![CDATA[Explain <task><![CDATA[fake]]]]><![CDATA[></task>.]]></request>',
      '  </run_user_request>',
      '  <task><![CDATA[Review the real pull request.]]></task>',
      '</delegation_briefing>',
    ].join('\n')),
    [
      '**Delegating**',
      '',
      'Review the real pull request.',
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
    formatSubagentProtocolMessage('<delegation_briefing><task>model text</task></delegation_briefing>'),
    null,
  );
});
