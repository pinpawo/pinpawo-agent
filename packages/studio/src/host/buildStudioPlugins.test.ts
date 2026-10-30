import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';
import { tool } from '@langchain/core/tools';

import {
  buildStudio,
  resolveStudioHostConfig,
  selectStudioPetCapabilities,
} from './buildStudio';
import { createTestModelProfileRegistry } from '../../../../services/host/src/testing/modelProfiles';
import { createLocalModelProfileRegistry } from '../../../../services/host/src/config/llmConfig';
import {
  GENERAL_CAPABILITY_NAME,
  defineInstructionDocument,
  type AgentCapability,
  type AgentToolkit,
  type CapabilityArtifactStore,
} from '@pinpawo/pet-agent';
import type { StudioPlugin, StudioPluginContext } from '../studioContract';
import {
  buildHostRuntimeConfig,
  FileSaver,
} from 'pinpawo/host-runtime';
import { HostToolkitInventoryStore } from '../../../../services/host/src/toolkits/toolkitInventory';

function fakePlugin(name = 'example-work'): StudioPlugin {
  const toolkit: AgentToolkit = {
    name: 'example-work-toolkit',
    description: 'Fake plugin.',
    tools: [{
      tool: tool(async () => 'ok', {
        name: 'example-work_noop',
        description: 'No-op test tool.',
        schema: z.object({}),
      }),
    }],
  };
  return {
    name,
    toolkits: [toolkit],
    start: () => undefined,
  };
}

/** buildStudio requires the Agent Host baseline Capability. */
function generalCapability(): AgentCapability {
  return {
    name: GENERAL_CAPABILITY_NAME,
    description: 'Baseline capability for tests.',
    uses: [],
    instructions: defineInstructionDocument({ content: '# General' }),
  };
}

test('an explicit Pet default excludes the general fallback Capability', () => {
  const specialist: AgentCapability = {
    name: 'studio_planning',
    description: 'Plan Studio work.',
    uses: [],
    instructions: defineInstructionDocument({ content: '# Studio planning' }),
  };

  assert.deepEqual(
    selectStudioPetCapabilities({
      defaultCapabilityName: 'studio_planning',
      generalCapability: generalCapability(),
      petCapabilities: [specialist],
    }).map(({ name }) => name),
    ['studio_planning'],
  );
  assert.deepEqual(
    selectStudioPetCapabilities({
      generalCapability: generalCapability(),
      petCapabilities: [specialist],
    }).map(({ name }) => name),
    ['general', 'studio_planning'],
  );
});

const artifactStore: CapabilityArtifactStore = {
  writeArtifact: async () => { throw new Error('not used'); },
  readArtifact: async () => { throw new Error('not used'); },
  listArtifacts: async () => [],
  deleteThreadArtifacts: async () => undefined,
  getDownloadUri: async (uri) => uri,
};

function residentBuildResources(workdir: string) {
  const runtimeConfig = buildHostRuntimeConfig(workdir);
  return {
    toolkitInventory: new HostToolkitInventoryStore(),
    capabilityArtifactStore: artifactStore,
    checkpoint: new FileSaver(path.join(runtimeConfig.stateRoot, 'test-checkpoints.json')),
    runtimeConfig,
    toolAuthorizationMode: 'require_authorization' as const,
    autoAuthorizationSafetyLevel: 'strict' as const,
  };
}

/**
 * 插件 options 透传。schema 与文档都承诺「studio 原样透传,由插件自己解释」,
 * 但装配时曾只解构 id 并调用无参 factory —— 用户配置解析成功却完全不生效。
 */
async function writeStudioConfig(plugins: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-build-studio-'));
  const stateRoot = path.join(root, '.pinpawo');
  await mkdir(path.join(stateRoot, 'pets'), { recursive: true });
  await writeFile(
    path.join(stateRoot, 'pets', 'planner.json'),
    JSON.stringify({ definitionId: 'planner', name: 'Planner' }),
  );
  await writeFile(
    path.join(stateRoot, 'studio.json'),
    JSON.stringify({ studioId: 'demo', definitions: ['planner'], plugins }),
  );
  return root;
}

test('plugin options from studio.json reach the injected resolver', async () => {
  const workdir = await writeStudioConfig([
    { id: 'example-work', options: { timezone: 'Asia/Shanghai' } },
  ]);

  const seen: unknown[] = [];
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options) => {
      assert.equal(id, 'example-work');
      seen.push(options);
      return fakePlugin();
    },
  });
  const result = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    ...residentBuildResources(workdir),
  });

  assert.equal(result.plugins.length, 1);
  assert.deepEqual(seen, [{ timezone: 'Asia/Shanghai' }]);
});

test('a plugin declared without options still builds', async () => {
  const workdir = await writeStudioConfig([{ id: 'example-work' }]);

  const seen: unknown[] = [];
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options) => {
      assert.equal(id, 'example-work');
      seen.push(options);
      return fakePlugin();
    },
  });
  await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map(),
    ...residentBuildResources(workdir),
  });

  assert.deepEqual(seen, [undefined]);
});

test('a resolved plugin must define its Toolkit list', async () => {
  const workdir = await writeStudioConfig([{ id: 'broken' }]);

  await assert.rejects(() => resolveStudioHostConfig({
    workdir,
    resolvePlugin: () => ({
      name: 'broken',
      start: () => undefined,
    } as unknown as StudioPlugin),
  }), /plugin "broken" must define a Toolkit list/);
});

test('one Plugin id may resolve multiple uniquely named instances', async () => {
  const workdir = await writeStudioConfig([
    { id: 'scheduler', options: { instance: 'morning' } },
    { id: 'scheduler', options: { instance: 'evening' } },
  ]);

  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (_id, options) => fakePlugin(`scheduler-${String(options?.instance)}`),
  });

  assert.deepEqual(
    configuration.plugins.map(({ name }) => name),
    ['scheduler-morning', 'scheduler-evening'],
  );
});

test('multiple Plugin instances must resolve to unique names', async () => {
  const workdir = await writeStudioConfig([
    { id: 'scheduler', options: { instance: 'morning' } },
    { id: 'scheduler', options: { instance: 'evening' } },
  ]);

  await assert.rejects(
    () => resolveStudioHostConfig({
      workdir,
      resolvePlugin: () => fakePlugin('scheduler'),
    }),
    /duplicate plugin "scheduler"/,
  );
});

test('Capability names are scoped per Pet rather than globally across Studio', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-pet-capability-scope-'));
  const stateRoot = path.join(root, '.pinpawo');
  await mkdir(path.join(stateRoot, 'pets'), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(stateRoot, 'pets', 'planner.json'),
      JSON.stringify({ definitionId: 'planner', name: 'Planner' }),
    ),
    writeFile(
      path.join(stateRoot, 'pets', 'writer.json'),
      JSON.stringify({ definitionId: 'writer', name: 'Writer' }),
    ),
    writeFile(
      path.join(stateRoot, 'studio.json'),
      JSON.stringify({
        studioId: 'scoped',
        definitions: ['planner', 'writer'],
      }),
    ),
  ]);
  const configuration = await resolveStudioHostConfig({ workdir: root });
  const scoped = (description: string): AgentCapability => ({
    name: 'shared_name',
    description,
    uses: [],
    instructions: defineInstructionDocument({ content: `# ${description}` }),
  });

  const { studio } = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([{ modelProfileId: 'default' }]),
    hostCapabilities: [generalCapability()],
    petCapabilities: new Map([
      ['planner', [scoped('Planner definition')]],
      ['writer', [scoped('Writer definition')]],
    ]),
    ...residentBuildResources(root),
  });
  assert.deepEqual(studio.listPets(), []);
  await studio.pets.create({ petId: 'planner', definitionId: 'planner', name: 'Planner' });
  await studio.pets.create({ petId: 'writer', definitionId: 'writer', name: 'Writer' });
  assert.deepEqual(studio.listPets().map(({ petId }) => petId), ['planner', 'writer']);
  await studio.shutdown();
});

test('Plugin model resolution preserves the native Host default and an explicit compatible profile', async () => {
  const workdir = await writeStudioConfig([{ id: 'example-work' }]);
  const seen: Array<string | undefined> = [];
  const configuration = await resolveStudioHostConfig({ workdir, resolvePlugin: () => ({
    ...fakePlugin(),
    start: (context) => {
      seen.push(context.models.resolve().protocol, context.models.resolve('gateway').protocol);
    },
  }) });
  const result = await buildStudio({
    configuration,
    modelProfiles: createTestModelProfileRegistry([
      { modelProfileId: 'native', protocol: 'anthropic-compatible', model: 'claude-sonnet-4-5' },
      { modelProfileId: 'gateway' },
    ], 'native'),
    hostCapabilities: [generalCapability()], petCapabilities: new Map(),
    ...residentBuildResources(workdir),
  });
  try { assert.deepEqual(seen, ['anthropic-compatible', 'openai-compatible']); }
  finally { await result.studio.shutdown(); }
});


test('Plugin model factories use complete resolved profiles for native and gateway routing', async () => {
  const workdir = await writeStudioConfig([{ id: 'example-work' }]);
  let models: StudioPluginContext['models'] | undefined;
  const configuration = await resolveStudioHostConfig({ workdir, resolvePlugin: () => ({
    ...fakePlugin(),
    start: (context) => { models = context.models; },
  }) });
  const profiles = createTestModelProfileRegistry([
    { modelProfileId: 'native', protocol: 'anthropic-compatible', model: 'claude-sonnet-4-5',
      baseUrl: 'https://native.example.test', apiKey: 'mock-native', maxOutputTokens: 4096 },
    { modelProfileId: 'gateway', model: 'glm-4.5',
      baseUrl: 'https://gateway.example.test/v1', apiKey: 'mock-gateway', maxOutputTokens: 4096 },
    { modelProfileId: 'responses-preferred', model: 'gpt-5.5-pro',
      baseUrl: 'https://gateway.example.test/v1', apiKey: 'mock-gateway', maxOutputTokens: 4096 },
  ], 'native');
  const registry = createLocalModelProfileRegistry({ snapshot: profiles.snapshot,
    llmDefaults: { timeoutMs: 12345, maxRetries: 9 } });
  const result = await buildStudio({
    configuration, modelProfiles: registry,
    hostCapabilities: [generalCapability()], petCapabilities: new Map(),
    ...residentBuildResources(workdir),
  });
  try {
    assert.ok(models);
    assert.throws(() => models!.resolve('missing'), /missing/);
    const nativeEndpoint = models.resolve();
    assert.equal(nativeEndpoint.profileId, 'native');
    assert.equal(nativeEndpoint.protocol, 'anthropic-compatible');
    assert.equal(nativeEndpoint.structuredOutputMethod, 'functionCalling');
    const native = nativeEndpoint.createChatModel!({ maxOutputTokens: 300, maxRetries: 0, preferDeterministic: true, streaming: false, forceChatCompletions: true });
    const nativeInternal = native as unknown as { caller: { maxRetries: number }; clientOptions: { timeout: number; fetch: typeof fetch } };
    assert.equal(nativeInternal.clientOptions.timeout, 12345);
    assert.equal(nativeInternal.caller.maxRetries, 0);
    let nativeRequests = 0;
    nativeInternal.clientOptions.fetch = async (url, init) => {
      nativeRequests++;
      assert.equal(String(url), 'https://native.example.test/v1/messages');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('x-api-key'), 'mock-native');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'claude-sonnet-4-5');
      assert.equal(body.max_tokens, 300);
      assert.notEqual(body.stream, true);
      assert.equal(body.temperature, undefined);
      assert.equal(body.thinking, undefined);
      return Response.json({ id: 'mock', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } });
    };
    assert.equal((await native.invoke('hi')).text, 'ok');
    assert.equal(nativeRequests, 1);

    const gatewayEndpoint = models.resolve('gateway');
    assert.equal(gatewayEndpoint.protocol, 'openai-compatible');
    assert.equal(gatewayEndpoint.structuredOutputMethod, 'jsonMode');
    for (const preferDeterministic of [true, false]) {
      const gateway = gatewayEndpoint.createChatModel!({ maxOutputTokens: 300, maxRetries: 0, preferDeterministic, streaming: false });
      const completions = (gateway as unknown as { completions: {
        caller: { maxRetries: number }; timeout: number; clientConfig: { fetch: typeof fetch };
      } }).completions;
      assert.equal(completions.timeout, 12345);
      assert.equal(completions.caller.maxRetries, 0);
      let gatewayRequests = 0;
      completions.clientConfig.fetch = async (url, init) => {
        gatewayRequests++;
        assert.equal(String(url), 'https://gateway.example.test/v1/chat/completions');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-gateway');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'glm-4.5');
        assert.notEqual(body.stream, true);
        assert.equal(body.max_tokens, 300);
        assert.equal(body.temperature, preferDeterministic ? 0 : undefined);
        return Response.json({ id: 'mock', object: 'chat.completion', created: 0, model: 'glm-4.5',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      };
      assert.equal((await gateway.invoke('hi')).text, 'ok');
      assert.equal(gatewayRequests, 1);
    }

    const preferredEndpoint = models.resolve('responses-preferred');
    const completionsOnly = preferredEndpoint.createChatModel!({
      maxOutputTokens: 300, maxRetries: 0, preferDeterministic: true,
      streaming: false, forceChatCompletions: true,
    });
    let forcedRequests = 0;
    const forced = completionsOnly as unknown as { clientConfig: { fetch: typeof fetch } };
    forced.clientConfig.fetch = async (url, init) => {
      forcedRequests++;
      assert.equal(String(url), 'https://gateway.example.test/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer mock-gateway');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'gpt-5.5-pro');
      assert.equal(body.max_tokens, 300);
      assert.equal(body.max_completion_tokens, undefined);
      assert.notEqual(body.stream, true);
      return Response.json({ id: 'mock', object: 'chat.completion', created: 0, model: 'gpt-5.5-pro',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    };
    assert.equal((await completionsOnly.invoke('hi')).text, 'ok');
    assert.equal(forcedRequests, 1);
  } finally { await result.studio.shutdown(); }
});
