import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { isAbortError, wrapToolCancellation } from './toolCancellation';

function makeTool(
  name: string,
  run: (input: { value?: string }, signal?: AbortSignal) => Promise<string>,
) {
  return tool(
    async (input: { value?: string }, runtime) => run(input, runtime.signal),
    {
      name,
      description: name,
      schema: z.object({ value: z.string().optional() }),
    },
  );
}

test('passes through a normal result when nothing is aborted', async () => {
  const wrapped = wrapToolCancellation(makeTool('ok', async () => 'done'));
  assert.equal(await wrapped.invoke({ value: 'x' }), 'done');
});

test('keeps execution failures as ordinary string results', async () => {
  // A non-zero exit or missing file must still reach the model as a result,
  // not become a thrown error.
  const wrapped = wrapToolCancellation(
    makeTool('fails', async () => 'Error: exit 1'),
  );
  const controller = new AbortController();
  const result = await wrapped.invoke({}, { signal: controller.signal });
  assert.equal(result, 'Error: exit 1');
});

test('throws AbortError when the tool swallows the abort and returns a string', async () => {
  // This is the real-world shape: the tool catches AbortError in its own
  // catch block and returns it as a normal value.
  const controller = new AbortController();
  const wrapped = wrapToolCancellation(makeTool('swallows', async () => {
    controller.abort();
    return 'Error: search aborted';
  }));

  await assert.rejects(
    () => wrapped.invoke({}, { signal: controller.signal }),
    (err: unknown) => isAbortError(err),
  );
});

test('throws AbortError when the signal is already aborted before the call', async () => {
  let called = false;
  const wrapped = wrapToolCancellation(makeTool('never', async () => {
    called = true;
    return 'should not run';
  }));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => wrapped.invoke({}, { signal: controller.signal }),
    (err: unknown) => isAbortError(err),
  );
  assert.equal(called, false, 'aborted call must not reach the tool');
});

test('normalizes a non-abort throw into AbortError once aborted', async () => {
  const controller = new AbortController();
  const wrapped = wrapToolCancellation(makeTool('throws', async () => {
    controller.abort();
    throw new Error('ECONNRESET');
  }));

  await assert.rejects(
    () => wrapped.invoke({}, { signal: controller.signal }),
    (err: unknown) => isAbortError(err),
  );
});

test('propagates a genuine error untouched when not aborted', async () => {
  const wrapped = wrapToolCancellation(makeTool('boom', async () => {
    throw new Error('boom');
  }));

  await assert.rejects(
    () => wrapped.invoke({}),
    (err: unknown) => err instanceof Error && err.message === 'boom' && !isAbortError(err),
  );
});

test('preserves tool identity used for review and operation lookup', async () => {
  const original = makeTool('run_shell', async () => 'ok');
  const wrapped = wrapToolCancellation(original);
  assert.equal(wrapped.name, 'run_shell');
  assert.equal(wrapped.description, 'run_shell');
  assert.ok(wrapped.schema, 'schema must remain reachable');
});
