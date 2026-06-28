import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import {
  createRepeatedInputGuard,
  createSubagentLoopGuardMiddleware,
  isLoopGuardStopMessage,
  LOOP_GUARD_MARKER_KEY,
  messagesHaveLoopGuardStop,
  readLoopGuardStopReason,
  type SubagentLoopGuardInput,
} from './loopGuards';

const SYS = new SystemMessage('sys');

function input(
  messages: BaseMessage[],
): SubagentLoopGuardInput {
  return {
    systemMessage: SYS,
    messages,
    iterationCount: 1,
  };
}

test('RepeatedInputGuard blocks after the same input recurs threshold times', () => {
  const guard = createRepeatedInputGuard(3);
  const same = [new HumanMessage('same task')];

  assert.equal(guard.evaluate(input(same)).block, false); // 1
  assert.equal(guard.evaluate(input(same)).block, false); // 2
  const verdict = guard.evaluate(input(same)); // 3 -> block
  assert.equal(verdict.block, true);
  if (verdict.block) {
    assert.equal(verdict.reason, 'repeated_input');
    assert.ok(isLoopGuardStopMessage(verdict.notice));
  }
});

test('RepeatedInputGuard resets its counter when the input changes', () => {
  const guard = createRepeatedInputGuard(3);
  const a = [new HumanMessage('a')];
  const b = [new HumanMessage('b')];

  guard.evaluate(input(a)); // a:1
  guard.evaluate(input(a)); // a:2
  assert.equal(guard.evaluate(input(b)).block, false); // b:1 (reset)
  assert.equal(guard.evaluate(input(b)).block, false); // b:2
  assert.equal(guard.evaluate(input(b)).block, true); // b:3
});

test('RepeatedInputGuard treats different tool-call content as distinct', () => {
  const guard = createRepeatedInputGuard(2);
  const turn1 = [new HumanMessage('task'), new AIMessage('step one')];
  const turn2 = [new HumanMessage('task'), new AIMessage('step two')];

  assert.equal(guard.evaluate(input(turn1)).block, false);
  // content changed -> not a repeat
  assert.equal(guard.evaluate(input(turn2)).block, false);
});

test('RepeatedInputGuard detects the same tool call across differing ids', () => {
  const guard = createRepeatedInputGuard(3);
  // Same tool name + args every turn, but a fresh tool-call id each time (the
  // common real-world case). The fingerprint must normalize the id away so this
  // is still detected as a repeat.
  const turnWithId = (id: string) => [
    new HumanMessage('task'),
    new AIMessage({ content: '', tool_calls: [{ id, name: 'grep_search', args: { query: 'x' } }] }),
  ];

  assert.equal(guard.evaluate(input(turnWithId('call-1'))).block, false);
  assert.equal(guard.evaluate(input(turnWithId('call-2'))).block, false);
  assert.equal(guard.evaluate(input(turnWithId('call-3'))).block, true);
});

test('RepeatedInputGuard separates same tool name with different args', () => {
  const guard = createRepeatedInputGuard(2);
  const call = (query: string) => [
    new AIMessage({ content: '', tool_calls: [{ id: 'c', name: 'grep_search', args: { query } }] }),
  ];
  assert.equal(guard.evaluate(input(call('a'))).block, false);
  // different args -> not a repeat
  assert.equal(guard.evaluate(input(call('b'))).block, false);
});

test('middleware ends the agent with a Command when the same model input repeats', async () => {
  const middleware = createSubagentLoopGuardMiddleware([createRepeatedInputGuard(3)], 'sys');
  assert.ok(middleware);
  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, 'function');

  const request = { messages: [new HumanMessage('same')], systemMessage: SYS } as never;
  let handlerCalls = 0;
  const handler = (async () => {
    handlerCalls += 1;
    return new AIMessage('model said something');
  }) as never;

  // First two identical inputs pass through to the model.
  await wrapModelCall!(request, handler);
  await wrapModelCall!(request, handler);
  assert.equal(handlerCalls, 2);

  // Third identical input blocks: returns a Command to END, no model call.
  const result = await wrapModelCall!(request, handler);
  assert.equal(handlerCalls, 2);
  assert.ok(result instanceof Command);
  const update = (result as Command).update as { messages?: BaseMessage[] };
  assert.ok(update.messages && messagesHaveLoopGuardStop(update.messages));
});

test('marker helpers detect guard stop notices', () => {
  const guard = createRepeatedInputGuard(1);
  const verdict = guard.evaluate(input([new HumanMessage('x')]));
  assert.equal(verdict.block, true);
  if (verdict.block) {
    assert.ok(isLoopGuardStopMessage(verdict.notice));
    assert.ok(messagesHaveLoopGuardStop([new HumanMessage('x'), verdict.notice]));
  }
  assert.equal(messagesHaveLoopGuardStop([new HumanMessage('x'), new AIMessage('y')]), false);
});

test('marker contract: only the closed reason domain is recognized', () => {
  // A guard stop notice round-trips to its typed reason.
  const repeated = createRepeatedInputGuard(1).evaluate(input([new HumanMessage('x')]));
  assert.equal(repeated.block, true);
  if (repeated.block) {
    assert.equal(readLoopGuardStopReason(repeated.notice), 'repeated_input');
  }

  // An unrelated pinpawo meta field on the same key namespace is NOT misread.
  const otherMeta = new AIMessage({
    content: 'hi',
    additional_kwargs: { pinpawo: { lane: 'general', runId: 'r1' } },
  });
  assert.equal(readLoopGuardStopReason(otherMeta), null);
  assert.equal(isLoopGuardStopMessage(otherMeta), false);

  // The marker key carrying an out-of-domain value is rejected (not a guard stop).
  const bogus = new AIMessage({
    content: 'hi',
    additional_kwargs: { pinpawo: { [LOOP_GUARD_MARKER_KEY]: 'something_else' } },
  });
  assert.equal(readLoopGuardStopReason(bogus), null);
  assert.equal(isLoopGuardStopMessage(bogus), false);

  // No pinpawo namespace at all.
  assert.equal(readLoopGuardStopReason(new AIMessage('plain')), null);
});
