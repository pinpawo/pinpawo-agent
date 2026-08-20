import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  buildLocalAgentRuntimeConfig,
  type HostCapabilityAssembly,
} from 'pinpawo/host-runtime';
import type { Studio } from './studioContract';
import type { BuildStudioResult } from './host/buildStudio';
import { startStudioHostStdio } from './startStudioHost';

function fakeAssembly(events: string[]): HostCapabilityAssembly {
  const runtimeConfig = buildLocalAgentRuntimeConfig('/tmp/pinpawo-start-studio-host-test');
  return {
    init: async () => { events.push('caps:init'); },
    shutdown: async () => { events.push('caps:shutdown'); },
    getRuntimeConfig: () => runtimeConfig,
    getModelProfiles: () => ({}) as never,
    getLocalCapabilities: () => [],
    getUserCapabilities: () => [],
    getToolkitInventoryStore: () => ({
      getSnapshot: () => ({ effectiveToolkits: [] }),
    }) as never,
    getToolkitRuntimeManager: () => ({}) as never,
    getCheckpointer: () => ({}) as never,
  } as unknown as HostCapabilityAssembly;
}

function fakeStudio(events: string[]): Studio {
  return {
    entryPetId: 'pet-a',
    dispatch: async () => ({ threadId: 'thread-1' }),
    onDispatchGate: () => () => {},
    notify: () => {},
    subscribe: () => () => {},
    listPets: () => [],
    shutdown: async () => { events.push('studio:shutdown'); },
  };
}

test('top-level stdio entry owns transport, diagnostics, and Host shutdown', async () => {
  const events: string[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  let protocolText = '';
  let diagnosticText = '';
  output.on('data', (chunk) => { protocolText += chunk.toString(); });
  diagnostics.on('data', (chunk) => { diagnosticText += chunk.toString(); });
  const previousConsole = globalThis.console;
  const assembly = fakeAssembly(events);
  assembly.init = async () => {
    events.push('caps:init');
    console.log('studio startup diagnostic');
  };
  const running = await startStudioHostStdio({
    capabilityAssembly: assembly,
    buildStudio: async (): Promise<BuildStudioResult> => {
      events.push('studio:build');
      return {
        studio: fakeStudio(events),
        resolved: {} as BuildStudioResult['resolved'],
        plugins: [],
      };
    },
  }, {
    input,
    output,
    diagnostics,
  });

  assert.notEqual(globalThis.console, previousConsole);
  input.end();
  await running.closed;

  assert.equal(globalThis.console, previousConsole);
  assert.equal(protocolText, '');
  assert.match(diagnosticText, /studio startup diagnostic/);
  assert.deepEqual(events, [
    'caps:init',
    'studio:build',
    'studio:shutdown',
    'caps:shutdown',
  ]);
});

test('top-level stdio entry restores console when Host initialization fails', async () => {
  const events: string[] = [];
  const previousConsole = globalThis.console;
  const assembly = fakeAssembly(events);
  assembly.init = async () => {
    console.log('failed studio startup diagnostic');
    throw new Error('init failed');
  };
  const diagnostics = new PassThrough();
  let diagnosticText = '';
  diagnostics.on('data', (chunk) => { diagnosticText += chunk.toString(); });

  await assert.rejects(() => startStudioHostStdio({
    capabilityAssembly: assembly,
    buildStudio: async () => assert.fail('Studio must not build'),
  }, {
    input: new PassThrough(),
    output: new PassThrough(),
    diagnostics,
  }), /init failed/);

  assert.equal(globalThis.console, previousConsole);
  assert.match(diagnosticText, /failed studio startup diagnostic/);
});
