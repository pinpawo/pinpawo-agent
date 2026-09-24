import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DelegationScope, RunScope, SessionScope, TaskScope } from './scope';
import type { SubagentExecutionScope, SubagentRuntimeContext } from './subagent';
import type { CapabilityFinalizeContext } from './capability';
import { subagentRuntimeContextSchema } from '../subagent/runtimeContext';

/** Each layer must be usable wherever a shallower one is expected. */
test('scope layers nest from session through delegation', () => {
  const delegation: DelegationScope = {
    threadId: 'thread-1', taskId: 'task-1', runId: 'run-1', delegationId: 'delegation-1',
  };
  const run: RunScope = delegation;
  const task: TaskScope = run;
  const session: SessionScope = task;
  assert.equal(session.threadId, 'thread-1');
  assert.equal(task.taskId, 'task-1');
  assert.equal(run.runId, 'run-1');

  // A shallower layer must not satisfy a deeper one.
  // @ts-expect-error RunScope has no delegationId.
  const widened: DelegationScope = { threadId: null, taskId: 't', runId: 'r' };
  void widened;
});

/**
 * These carry an execution identity, so they extend the scope types rather than
 * redeclaring the fields — adding a layer stays one edit.
 */
test('execution structures derive their identity from DelegationScope', () => {
  const base: DelegationScope = {
    threadId: null, taskId: 'task-1', runId: 'run-1', delegationId: 'delegation-1',
  };
  const subagent: SubagentExecutionScope = { ...base, workdir: null };
  const finalize: CapabilityFinalizeContext = {
    ...base, capabilityId: 'general', models: {} as CapabilityFinalizeContext['models'], messages: [],
  };
  assert.equal(subagent.taskId, 'task-1');
  assert.equal(finalize.taskId, 'task-1');
});

/** The runtime schema is validated at the boundary, so it must not drift. */
test('subagent runtime context schema accepts and requires every scope layer', () => {
  const scope = {
    threadId: 'thread-1', taskId: 'task-1', runId: 'run-1', delegationId: 'delegation-1',
  };
  const parsed = subagentRuntimeContextSchema.parse({ executionScope: scope });
  assert.deepEqual((parsed as SubagentRuntimeContext).executionScope, scope);

  const { taskId: _dropped, ...withoutTask } = scope;
  assert.throws(() => subagentRuntimeContextSchema.parse({ executionScope: withoutTask }));
});
