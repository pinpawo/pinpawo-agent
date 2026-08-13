import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStudio } from './createStudio';
import type { StudioPlugin, StudioPluginContext } from './studioContract';
import type {
  PetAgentRuntime,
  PetAgentRuntimeInvokeInput,
  PetAgentRuntimeInvokeResult,
} from './types';

function pet(options: {
  petId: string;
  status?: 'standby' | 'active' | 'disabled';
  onInvoke?: (input: PetAgentRuntimeInvokeInput) => void;
  reply?: string;
  fail?: boolean;
  /** 让某次 invoke 挂住,用于观察队列。 */
  hold?: (brief: string) => Promise<void>;
}): PetAgentRuntime {
  return {
    descriptor: () => ({
      petId: options.petId,
      userId: null,
      name: options.petId,
      personality: null,
      stage: null,
      species: null,
      role: null,
      serviceSummary: null,
      startupMode: options.status === 'disabled' ? 'disabled' : 'standby',
      status: options.status ?? 'standby',
      capabilities: [],
    }),
    invoke: async (input): Promise<PetAgentRuntimeInvokeResult> => {
      options.onInvoke?.(input);
      await options.hold?.(input.brief);
      if (options.fail) throw new Error('pet exploded');
      return { reply: options.reply ?? 'done' };
    },
  };
}

/** 让 fire-and-forget 的 dispatch 有机会跑到 pet.invoke。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('dispatch returns as soon as the request is sent, without waiting for the pet', async () => {
  // 推模型的核心:studio 派完就不管。若它等 pet 干完,这里会被 gate 卡住。
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [{
      ...pet({ petId: 'worker' }),
      invoke: async () => {
        await gate;
        return { reply: 'eventually' };
      },
    }],
  });

  // 加超时:若 studio 退化成等 pet 干完,这里会挂住 —— 用超时把"挂住"
  // 变成一个明确的失败,而不是让测试卡死。
  const result = await Promise.race([
    studio.dispatch({ petId: 'worker', request: 'do it' }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('dispatch did not return; studio waited for the pet')), 200);
    }),
  ]);

  assert.match(result.threadId, /^studio:s1:pet:worker:dispatch:/);
  release();
});

test('dispatch result carries no pet output', async () => {
  // 返回值只表示"已经发出去了" —— reply 经由 toolkit → 插件 → event 汇报,
  // 不走这条路。
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker', reply: 'the answer' })],
  });

  const result = await studio.dispatch({ petId: 'worker', request: 'go' });
  await flush();

  assert.deepEqual(Object.keys(result), ['threadId']);
});

test('a failing pet does not reject the dispatch call', async () => {
  // 判定与善后属于插件的领域;studio 不越权处理,更不该把失败抛回发起方。
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'worker',
    pets: [pet({ petId: 'worker', fail: true })],
  });

  await assert.doesNotReject(() => studio.dispatch({ petId: 'worker', request: 'go' }));
  await flush();
});

test('the entry pet is just a pet — dispatching to it needs no special API', async () => {
  const seen: string[] = [];
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'entry',
    pets: [
      pet({ petId: 'entry', onInvoke: (input) => seen.push(`entry:${input.brief}`) }),
      pet({ petId: 'other', onInvoke: () => seen.push('other') }),
    ],
  });

  await studio.dispatch({ petId: studio.entryPetId, request: 'write something' });
  await flush();

  assert.deepEqual(seen, ['entry:write something']);
});

test('dispatch rejects unknown and disabled pets', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'ok',
    pets: [pet({ petId: 'ok' }), pet({ petId: 'off', status: 'disabled' })],
  });

  await assert.rejects(
    () => studio.dispatch({ petId: 'ghost', request: 'go' }),
    /unknown petId "ghost"/,
  );
  await assert.rejects(
    () => studio.dispatch({ petId: 'off', request: 'go' }),
    /is disabled/,
  );
});

test('concurrent dispatches to one pet queue instead of being rejected', async () => {
  // 多个插件并发给同一个 pet 派活是常态(kanban + scheduler + http…)。
  // 从前第二个会撞上 status === 'active' 被拒,派活凭空丢掉。
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'p1',
    pets: [pet({
      petId: 'p1',
      onInvoke: (input) => { started.push(input.brief); },
      hold: async (brief) => { if (brief === 'first') await firstRunning; },
    })],
  });

  await studio.dispatch({ petId: 'p1', request: 'first' });
  await studio.dispatch({ petId: 'p1', request: 'second' });
  await flush();

  // 第一个在跑,第二个还排着 —— 但它没有被拒绝。
  assert.deepEqual(started, ['first']);

  releaseFirst();
  await flush();
  assert.deepEqual(started, ['first', 'second']);
});

test('dispatch is refused after shutdown', async () => {
  // 关掉之后再派活,没有任何插件在听它的产出 —— 那是一扇没关紧的门。
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'p1',
    pets: [pet({ petId: 'p1' })],
  });
  await studio.shutdown();

  await assert.rejects(
    () => studio.dispatch({ petId: 'p1', request: 'go' }),
    /already shut down/,
  );
});

test('createStudio rejects an entryPetId that is not among the pets', async () => {
  await assert.rejects(
    () => createStudio({ studioId: 's1', entryPetId: 'ghost', pets: [pet({ petId: 'p1' })] }),
    /entryPetId "ghost" is not among the configured pets/,
  );
});

test('events are broadcast to every subscriber without being interpreted', async () => {
  // studio 不认识任何 event type,也不校验 payload —— 它只转发。
  const received: unknown[] = [];
  let publish!: StudioPluginContext['notify'];

  const publisher: StudioPlugin = {
    name: 'kanban',
    description: 'kanban',
    tools: [],
    studio: { start: (context) => { publish = context.notify; } },
  };
  const listener: StudioPlugin = {
    name: 'scheduler',
    description: 'scheduler',
    tools: [],
    studio: { start: (context) => { context.subscribe((event) => { received.push(event); }); } },
  };

  await createStudio({
    studioId: 's1',
    entryPetId: 'p1',
    pets: [pet({ petId: 'p1' })],
    plugins: [publisher, listener],
  });

  publish({ type: 'task.done', correlationId: 'card-1', payload: { anything: true } });
  await flush();

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    type: 'task.done',
    // source 由 studio 按发布插件补齐，订阅方据此判断来源。
    source: 'kanban',
    correlationId: 'card-1',
    payload: { anything: true },
    occurredAt: (received[0] as { occurredAt: string }).occurredAt,
  });
});

test('one failing subscriber does not stop the others', async () => {
  const delivered: string[] = [];
  let publish!: StudioPluginContext['notify'];

  await createStudio({
    studioId: 's1',
    entryPetId: 'p1',
    pets: [pet({ petId: 'p1' })],
    plugins: [
      {
        name: 'source',
        description: 'source',
        tools: [],
        studio: { start: (context) => { publish = context.notify; } },
      },
      {
        name: 'broken',
        description: 'broken',
        tools: [],
        studio: {
          start: (context) => {
            context.subscribe(() => { throw new Error('handler exploded'); });
          },
        },
      },
      {
        name: 'healthy',
        description: 'healthy',
        tools: [],
        studio: { start: (context) => { context.subscribe(() => { delivered.push('healthy'); }); } },
      },
    ],
  });

  publish({ type: 'anything' });
  await flush();

  assert.deepEqual(delivered, ['healthy']);
});

test('plugins are started in order and stopped in reverse', async () => {
  const order: string[] = [];
  const make = (name: string): StudioPlugin => ({
    name,
    description: name,
    tools: [],
    studio: {
      start: () => { order.push(`start:${name}`); },
      stop: () => { order.push(`stop:${name}`); },
    },
  });

  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'p1',
    pets: [pet({ petId: 'p1' })],
    plugins: [make('a'), make('b')],
  });
  await studio.shutdown();

  // 逆序停止:后启动的插件可能依赖先启动的。
  assert.deepEqual(order, ['start:a', 'start:b', 'stop:b', 'stop:a']);
});

test('a plugin that fails to start fails createStudio', async () => {
  // 一个没起来的驱动器意味着这块 studio 不会派活,静默吞掉会变成
  // "提交了但什么都没发生"。
  await assert.rejects(
    () => createStudio({
      studioId: 's1',
      entryPetId: 'p1',
      pets: [pet({ petId: 'p1' })],
      plugins: [{
        name: 'broken',
        description: 'broken',
        tools: [],
        studio: { start: () => { throw new Error('cannot start'); } },
      }],
    }),
    /cannot start/,
  );
});

test('a plugin without a studio aspect is just a toolkit', async () => {
  const studio = await createStudio({
    studioId: 's1',
    entryPetId: 'p1',
    pets: [pet({ petId: 'p1' })],
    plugins: [{ name: 'plain', description: 'plain toolkit', tools: [] }],
  });

  assert.deepEqual(studio.listPets().map((descriptor) => descriptor.petId), ['p1']);
  await studio.shutdown();
});

test('a dispatch records who sent it, using the plugin name studio supplies', async () => {
  // source 目前只做记录。关键是它由 studio 从 context 补 —— 插件自报的
  // 来源迟早会撒谎。dispatch 是点对点的:不上总线,也不进 pet.invoke。
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };

  try {
    let ctx!: StudioPluginContext;
    const kanban: StudioPlugin = {
      name: 'kanban',
      description: 'test plugin',
      tools: [],
      studio: { start: (context) => { ctx = context; } },
    };

    const studio = await createStudio({
      studioId: 's1',
      entryPetId: 'p1',
      pets: [pet({ petId: 'p1' })],
      plugins: [kanban],
    });

    await ctx.dispatch({ petId: 'p1', request: 'from plugin' });
    await studio.dispatch({ petId: studio.entryPetId, request: 'from user' });
    await flush();

    const sources = lines
      .filter((line) => line.includes('[studio] dispatch petId='))
      .map((line) => line.match(/source=(\S+)/)?.[1]);
    assert.deepEqual(sources, ['kanban', 'studio']);
  } finally {
    console.log = original;
  }
});
