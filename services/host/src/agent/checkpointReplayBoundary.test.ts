import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt, task } from '@langchain/langgraph';
import { FileSaver } from '../fileSaver';

const State = Annotation.Root({
  result: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
});

function makeGraph(checkpointer: MemorySaver | FileSaver, counters: { policies: number; effects: number }) {
  const child = new StateGraph(State).addNode('review', async () => {
    await task('policy', async () => { counters.policies++; return 'human review'; })();
    const decision = interrupt({ kind: 'review' });
    if (decision === 'approve') counters.effects++;
    return { result: String(decision) };
  }).addEdge(START, 'review').addEdge('review', END).compile();
  return new StateGraph(State).addNode('child', (state, config) => child.invoke(state, config))
    .addEdge(START, 'child').addEdge('child', END).compile({ checkpointer });
}

type Output = typeof State.State & { __interrupt__?: Array<{ id?: string }> };

test('MemorySaver historical replay may rerun an already completed nested policy and action', async () => {
  const saver = new MemorySaver();
  const counters = { policies: 0, effects: 0 };
  const config = { configurable: { thread_id: 'history-replay' } };
  const paused = await makeGraph(saver, counters).invoke({ result: '' }, config) as Output;
  const id = paused.__interrupt__?.[0]?.id;
  assert.ok(id);
  const done = await makeGraph(saver, counters).invoke(new Command({ resume: { [id]: 'approve' } }), config);
  assert.equal(done.result, 'approve');
  assert.deepEqual(counters, { policies: 1, effects: 1 });
  const history = [];
  for await (const snapshot of makeGraph(saver, counters).getStateHistory(config)) history.push(snapshot);
  const beforeExecution = history.find(snapshot => snapshot.next.includes('__start__'));
  assert.ok(beforeExecution);
  const replay = await makeGraph(saver, counters).invoke(null, beforeExecution.config) as Output;
  const replayId = replay.__interrupt__?.[0]?.id;
  assert.ok(replayId);
  assert.deepEqual(counters, { policies: 2, effects: 1 }, 'time travel reruns the old policy');
  const replayed = await makeGraph(saver, counters).invoke(new Command({ resume: { [replayId]: 'approve' } }), config);
  assert.equal(replayed.result, 'approve');
  assert.deepEqual(counters, { policies: 2, effects: 2 }, 'the action may also execute again after an explicit replay');
});

test('FileSaver latest-only retention does not offer an older root checkpoint for time travel', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-replay-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'checkpoints.json');
  const counters = { policies: 0, effects: 0 };
  const config = { configurable: { thread_id: 'latest-only' } };
  const paused = await makeGraph(new FileSaver(path), counters).invoke({ result: '' }, config) as Output;
  const id = paused.__interrupt__?.[0]?.id;
  assert.ok(id);
  const historical = (await makeGraph(new FileSaver(path), counters).getState(config)).config;
  assert.ok(historical.configurable?.checkpoint_id);
  const done = await makeGraph(new FileSaver(path), counters).invoke(new Command({ resume: { [id]: 'approve' } }), config);
  assert.equal(done.result, 'approve');
  assert.deepEqual(counters, { policies: 1, effects: 1 });
  const restarted = new FileSaver(path);
  assert.equal(await restarted.getTuple(historical), undefined);
  const latest = await restarted.getTuple(config);
  assert.ok(latest?.config.configurable?.checkpoint_id);
  assert.notEqual(latest.config.configurable.checkpoint_id, historical.configurable.checkpoint_id);
  assert.equal(latest.checkpoint.channel_values.result, 'approve');
  assert.deepEqual(counters, { policies: 1, effects: 1 });
});
