import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { FileSaver } from '../fileSaver';
import { createSessionUsageTracker, summarizeSessionUsage } from './sessionUsageLedger';

const usage = (input = 100, output = 20) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
const result = (input = 100, output = 20) => ({ generations: [[{ text: 'done', message: new AIMessage({ content: 'done', usage_metadata: { input_tokens: input, output_tokens: output, total_tokens: input + output } }) }]] });

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'checkpoint.json');
  return { path, store: new FileSaver(path) };
}

test('calls survive saver reload and replay; child/retry calls remain separate; deletion clears usage', async t => {
  const { store, path } = fixture(t);
  await Promise.all([
    store.putSessionUsageCall('session', 'root', { usage: usage() }),
    store.putSessionUsageCall('session', 'child', { usage: usage(50, 10) }),
    store.putSessionUsageCall('session', 'retry-failed', {}),
  ]);
  await store.putSessionUsageCall('session', 'root', { usage: usage() });
  await store.putSessionUsageCall('session', 'root', { pending: true });
  const restored = new FileSaver(path);
  const total = summarizeSessionUsage(restored.readSessionUsage('session')!);
  assert.equal(total.totalTokens, 180);
  assert.equal(total.unknownCalls, 1);
  assert.equal(total.incomplete, true);
  assert.equal(restored.readSessionUsage('different-session'), null);
  await restored.deleteThread('session');
  assert.equal(restored.readSessionUsage('session'), null);
});

test('native streaming usage replaces intermediate totals and final provider output determines speed', async t => {
  const { store } = fixture(t);
  let clock = 0;
  const snapshots: number[] = [];
  const { callbacks } = createSessionUsageTracker({ store, threadId: 's', now: () => clock, onUsage: u => snapshots.push(u.totalTokens) });
  await callbacks.handleChatModelStart!({} as never, [], 'call');
  clock = 5000; // TTFT is excluded.
  await callbacks.handleChatModelStreamEvent!({ event: 'content-block-delta', index: 0, delta: { type: 'reasoning-delta', reasoning: 'thought' } }, 'call');
  clock = 5500;
  await callbacks.handleChatModelStreamEvent!({ event: 'content-block-delta', index: 1, delta: { type: 'text-delta', text: 'many words in one chunk' } }, 'call');
  await callbacks.handleChatModelStreamEvent!({ event: 'usage', usage: { input_tokens: 100, output_tokens: 8, total_tokens: 108 } }, 'call');
  assert.equal(summarizeSessionUsage(store.readSessionUsage('s')!).totalTokens, 108);
  assert.equal(summarizeSessionUsage(store.readSessionUsage('s')!).incomplete, true);
  clock = 6000;
  await callbacks.handleLLMEnd!(result(), 'call');
  const total = summarizeSessionUsage(store.readSessionUsage('s')!);
  assert.equal(total.totalTokens, 120);
  assert.equal(total.outputTokensPerSecond, 20);
  assert.equal(total.incomplete, undefined);
  assert.deepEqual(snapshots, [0, 108, 120]);
});

test('nonstreaming, single buffered chunk, missing usage and interrupted starts keep speed unknown', async t => {
  const { store } = fixture(t);
  const { callbacks } = createSessionUsageTracker({ store, threadId: 's', now: () => 100 });
  await callbacks.handleChatModelStart!({} as never, [], 'nonstream');
  await callbacks.handleLLMEnd!(result(), 'nonstream');
  assert.equal(summarizeSessionUsage(store.readSessionUsage('s')!).outputTokensPerSecond, undefined);
  await callbacks.handleChatModelStart!({} as never, [], 'buffered');
  await callbacks.handleLLMNewToken!('whole reply', { prompt: 0, completion: 0 }, 'buffered');
  await callbacks.handleLLMEnd!(result(), 'buffered');
  await callbacks.handleChatModelStart!({} as never, [], 'failed');
  await callbacks.handleLLMError!(new Error('failure'), 'failed');
  await callbacks.handleChatModelStart!({} as never, [], 'crashed');
  await callbacks.handleChatModelStart!({} as never, [], 'no-usage');
  const unreported = { generations: [[{ text: 'done', message: new AIMessage('done') }]] };
  await callbacks.handleLLMEnd!(unreported, 'no-usage');
  const total = summarizeSessionUsage(store.readSessionUsage('s')!);
  assert.equal(total.totalTokens, 240);
  assert.equal(total.unknownCalls, 3);
  assert.equal(total.outputTokensPerSecond, undefined);
});

test('legacy baseline is imported once; compacted messages cannot reduce the ledger', async t => {
  const { store, path } = fixture(t);
  const baseline = { ...usage(500, 100), incomplete: true };
  await store.putSessionUsageCall('s', 'first', { usage: usage() }, baseline);
  await new FileSaver(path).putSessionUsageCall('s', 'resumed', { usage: usage() }, baseline);
  const total = summarizeSessionUsage(new FileSaver(path).readSessionUsage('s')!);
  assert.equal(total.totalTokens, 840);
  assert.equal(total.incomplete, true);
});

test('failed streaming calls retain reported partial usage and mark the total incomplete', async t => {
  const { store } = fixture(t);
  const { callbacks } = createSessionUsageTracker({ store, threadId: 's' });
  await callbacks.handleChatModelStart!({} as never, [], 'failed');
  await callbacks.handleChatModelStreamEvent!({ event: 'usage', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } }, 'failed');
  await callbacks.handleLLMError!(new Error('disconnected'), 'failed');
  const total = summarizeSessionUsage(store.readSessionUsage('s')!);
  assert.equal(total.totalTokens, 110);
  assert.equal(total.incomplete, true);
  assert.equal(total.unknownCalls, 1);
});

test('inherited callbacks capture parallel child models and retry model invocations', async t => {
  const { BaseChatModel } = await import('@langchain/core/language_models/chat_models');
  const { RunnableLambda } = await import('@langchain/core/runnables');
  const { store } = fixture(t);
  const tracker = createSessionUsageTracker({ store, threadId: 'nested' });
  class LocalModel extends BaseChatModel {
    _llmType() { return 'usage-child-fixture'; }
    async _generate() { return { generations: result(10, 2).generations[0] }; }
  }
  const child = new LocalModel({});
  const delegated = RunnableLambda.from(async (_input: string, config) => {
    return Promise.all([child.invoke('child a', config), child.invoke('child b', config)]);
  });
  await delegated.invoke('root', { callbacks: [tracker.callbacks] });
  const total = summarizeSessionUsage(store.readSessionUsage('nested')!);
  assert.equal(total.totalTokens, 24);
  assert.equal(Object.keys(store.readSessionUsage('nested')!.calls).length, 2);
  class RetryModel extends LocalModel {
    attempts = 0;
    override async _generate() {
      this.attempts++;
      if (this.attempts === 1) throw new Error('retry fixture');
      return super._generate();
    }
  }
  const retry = new RetryModel({});
  await retry.withRetry({ stopAfterAttempt: 2 }).invoke('retry', { callbacks: [tracker.callbacks] });
  const retried = summarizeSessionUsage(store.readSessionUsage('nested')!);
  assert.equal(retried.totalTokens, 36);
  assert.equal(retried.unknownCalls, 1);
  assert.equal(retried.incomplete, true);
});

test('partial native snapshots merge unchanged input and unreported final retains known partial totals', async t => {
  const { store } = fixture(t);
  const { callbacks } = createSessionUsageTracker({ store, threadId: 's' });
  await callbacks.handleChatModelStart!({} as never, [], 'call');
  await callbacks.handleChatModelStreamEvent!({ event: 'message-start', usage: { input_tokens: 100 } }, 'call');
  await callbacks.handleChatModelStreamEvent!({ event: 'usage', usage: { output_tokens: 10 } }, 'call');
  assert.equal(summarizeSessionUsage(store.readSessionUsage('s')!).totalTokens, 110);
  const noUsage = { generations: [[{ text: 'done', message: new AIMessage('done') }]] };
  await callbacks.handleLLMEnd!(noUsage, 'call');
  const total = summarizeSessionUsage(store.readSessionUsage('s')!);
  assert.equal(total.totalTokens, 110);
  assert.equal(total.incomplete, true);
  assert.equal(total.outputTokensPerSecond, undefined);
});

test('a final usage report missing output never invents zero output speed', async t => {
  const { store } = fixture(t);
  let now = 0;
  const { callbacks } = createSessionUsageTracker({ store, threadId: 's', now: () => now });
  await callbacks.handleChatModelStart!({} as never, [], 'partial');
  await callbacks.handleLLMNewToken!('a', { prompt: 0, completion: 0 }, 'partial');
  now = 100;
  await callbacks.handleLLMNewToken!('b', { prompt: 0, completion: 0 }, 'partial');
  now = 1000;
  const partial = { generations: [[{ text: 'done', message: { usage_metadata: { input_tokens: 100 } } }]] };
  await callbacks.handleLLMEnd!(partial, 'partial');
  const usage = summarizeSessionUsage(store.readSessionUsage('s')!);
  assert.equal(usage.outputTokensPerSecond, undefined);
  assert.equal(usage.incomplete, true);
});

test('hidden reasoning output is not divided by the visible-text interval', async t => {
  const { store } = fixture(t);
  let now = 0;
  let displayedRate: number | undefined;
  const { callbacks } = createSessionUsageTracker({ store, threadId: 's', now: () => now, onUsage: usage => { displayedRate = usage.outputTokensPerSecond; } });
  await callbacks.handleChatModelStart!({} as never, [], 'reasoning');
  await callbacks.handleLLMNewToken!('a', { prompt: 0, completion: 0 }, 'reasoning');
  now = 500;
  await callbacks.handleLLMNewToken!('b', { prompt: 0, completion: 0 }, 'reasoning');
  now = 1000;
  await callbacks.handleChatModelStreamEvent!({ event: 'usage', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, output_token_details: { reasoning: 15 } } }, 'reasoning');
  assert.equal(displayedRate, undefined);
  const reported = result();
  reported.generations[0][0].message.usage_metadata!.output_token_details = { reasoning: 15 };
  await callbacks.handleLLMEnd!(reported, 'reasoning');
  const usage = summarizeSessionUsage(store.readSessionUsage('s')!);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.outputTokensPerSecond, undefined);
});

test('parallel callbacks publish canonical per-call speed and the restored latest completion', async t => {
  const { store, path } = fixture(t);
  let clock = 0;
  const observed: Array<{ outputTokensPerSecond?: number; outputRateSource?: string; totalTokens: number }> = [];
  const { callbacks } = createSessionUsageTracker({ store, threadId: 'parallel', now: () => clock, onUsage: usage => observed.push(usage) });
  await callbacks.handleChatModelStart!({} as never, [], 'a');
  await callbacks.handleLLMNewToken!('first', { prompt: 0, completion: 0 }, 'a');
  clock = 500;
  await callbacks.handleChatModelStart!({} as never, [], 'b');
  await callbacks.handleLLMNewToken!('first', { prompt: 0, completion: 0 }, 'b');
  clock = 1000;
  await callbacks.handleLLMNewToken!('second', { prompt: 0, completion: 0 }, 'a');
  await callbacks.handleLLMNewToken!('second', { prompt: 0, completion: 0 }, 'b');
  await callbacks.handleLLMEnd!(result(100, 10), 'b');
  assert.equal(observed.at(-1)?.outputTokensPerSecond, 20);
  clock = 2000;
  await callbacks.handleLLMEnd!(result(100, 20), 'a');
  const restored = summarizeSessionUsage(new FileSaver(path).readSessionUsage('parallel')!);
  assert.equal(restored.outputTokensPerSecond, 10);
  assert.equal(observed.at(-1)?.outputTokensPerSecond, restored.outputTokensPerSecond);
  const revision = restored.usageRevision;
  await callbacks.handleLLMError!(new Error('late'), 'a');
  await callbacks.handleChatModelStreamEvent!({ event: 'usage', usage: { input_tokens: 100, output_tokens: 1 } }, 'a');
  const replayed = summarizeSessionUsage(store.readSessionUsage('parallel')!);
  assert.equal(replayed.totalTokens, 230);
  assert.equal(replayed.outputTokensPerSecond, 10);
  assert.equal(replayed.incomplete, undefined);
  assert.equal(replayed.usageRevision, revision);
});

test('one model call with alternative choices counts shared usage only once', async t => {
  const { store } = fixture(t);
  const { callbacks } = createSessionUsageTracker({ store, threadId: 'choices' });
  const response = result();
  response.generations[0].push(response.generations[0][0]);
  await callbacks.handleChatModelStart!({} as never, [], 'model');
  await callbacks.handleLLMEnd!(response, 'model');
  assert.equal(summarizeSessionUsage(store.readSessionUsage('choices')!).totalTokens, 120);
});

test('invalid persisted ledger shapes are rejected instead of becoming complete zero usage', async t => {
  const { parseSessionUsageLedger } = await import('./sessionUsageLedger');
  for (const value of [null, { version: 1, calls: [] }, { version: 1, calls: { model: null } },
    { version: 1, calls: { model: { usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 } } } },
    { version: 1, revision: -1, calls: {} }]) assert.throws(() => parseSessionUsageLedger(value));
});

test('a corrupt usage file reads as absent so the session still loads and the next write replaces it', async t => {
  const { store, path } = fixture(t);
  await store.putSessionUsageCall('s', 'first', { usage: usage() });
  const file = readdirSync(dirname(path), { recursive: true, encoding: 'utf8' })
    .find(entry => entry.endsWith('usage.json'))!;
  writeFileSync(join(dirname(path), file), '{ not json');
  assert.equal(store.readSessionUsage('s'), null);
  await store.putSessionUsageCall('s', 'next', { usage: usage(10, 5) }, { ...usage(), incomplete: true });
  const total = summarizeSessionUsage(new FileSaver(path).readSessionUsage('s')!);
  assert.equal(total.totalTokens, 135);
  assert.equal(total.incomplete, true);
});

test('a failed ledger write never fails the model call and keeps the published total incomplete', async t => {
  const { store } = fixture(t);
  let failWrites = true;
  const flaky = {
    readSessionUsage: (id: string) => store.readSessionUsage(id),
    putSessionUsageCall: async (...args: Parameters<FileSaver['putSessionUsageCall']>) => {
      if (failWrites) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await store.putSessionUsageCall(...args);
    },
  };
  const published: { incomplete?: boolean; unknownCalls?: number; totalTokens: number }[] = [];
  const { callbacks } = createSessionUsageTracker({ store: flaky, threadId: 's', onUsage: u => published.push(u) });
  assert.equal(callbacks.raiseError, false);
  await callbacks.handleChatModelStart!({} as never, [], 'lost');
  await callbacks.handleLLMEnd!(result() as never, 'lost');
  assert.deepEqual(published.at(-1), { inputTokens: 0, outputTokens: 0, totalTokens: 0, incomplete: true, unknownCalls: 1 });
  failWrites = false;
  await callbacks.handleChatModelStart!({} as never, [], 'kept');
  await callbacks.handleLLMEnd!(result(10, 5) as never, 'kept');
  assert.equal(published.at(-1)!.totalTokens, 15);
  assert.equal(published.at(-1)!.incomplete, true);
  assert.equal(published.at(-1)!.unknownCalls, 1);
});

test('reasoning details retained only in raw response metadata still suppress a text-only rate', async t => {
  const { store } = fixture(t);
  let clock = 0;
  const { callbacks } = createSessionUsageTracker({ store, threadId: 'raw-reasoning', now: () => clock });
  await callbacks.handleChatModelStart!({} as never, [], 'model');
  await callbacks.handleLLMNewToken!('a', { prompt: 0, completion: 0 }, 'model');
  clock = 500;
  await callbacks.handleLLMNewToken!('b', { prompt: 0, completion: 0 }, 'model');
  clock = 1000;
  const response = result();
  response.generations[0][0].message.response_metadata = { usage: { completion_tokens_details: { reasoning_tokens: 15 } } };
  await callbacks.handleLLMEnd!(response, 'model');
  assert.equal(summarizeSessionUsage(store.readSessionUsage('raw-reasoning')!).outputTokensPerSecond, undefined);
});
