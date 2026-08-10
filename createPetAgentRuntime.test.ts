
test('a review interrupt returns waiting_review instead of blocking the invoke', async () => {
  // HITL 对 Studio 透明(#561):撞到 review 就把进度留在 checkpoint 上返回,
  // 不在 invoke 内部等人。答复经 pet-agent 既有的 resume 路径送回,与 chat 同路。
  const { graph, calls } = makeStubGraph([
    { __interrupt__: [{ value: sampleReviewInterrupt }] },
  ]);
  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
  });

  const result = await runtime.invoke({
    brief: 'needs a human',
    threadId: 'studio:s1:pet:p1:invocation:i1',
  });

  assert.deepEqual(result, {
    status: 'waiting_review',
    threadId: 'studio:s1:pet:p1:invocation:i1',
  });
  // 关键:只调用一次 graph —— 没有内部循环在等人。
  assert.equal(calls.length, 1);
});

test('a review interrupt without a threadId fails loudly', async () => {
  // 没有 threadId 就无从 resume;返回一个接不回来的 waiting_review 更糟。
  const { graph } = makeStubGraph([
    { __interrupt__: [{ value: sampleReviewInterrupt }] },
  ]);
  const runtime = createPetAgentRuntime({
    models: fakeModels(),
    actor: fakeActor(),
    graph,
  });

  await assert.rejects(
    () => runtime.invoke({ brief: 'needs a human' }),
    /threadId to resume from/,
  );
});
