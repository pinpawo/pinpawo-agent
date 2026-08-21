import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type {
  RunningStudioHost,
  StartStudioHostOptions,
  StudioModuleResolver,
} from '@pinpawo/studio';
import type { LocalAgentRuntimeConfig } from 'pinpawo/host-runtime';
import { runStudioHostApplication } from './studioHostApplication';

function runtimeConfig(workdir: string): LocalAgentRuntimeConfig {
  return { workdir } as LocalAgentRuntimeConfig;
}

function completedHost(): RunningStudioHost {
  return {
    host: {} as RunningStudioHost['host'],
    close: () => undefined,
    closed: Promise.resolve(),
  };
}

test('Studio application composes resolver before starting stdio', async () => {
  const config = runtimeConfig('/resolved/project');
  const resolver: StudioModuleResolver = async () => ({
    plugin: {} as Awaited<ReturnType<StudioModuleResolver>>['plugin'],
  });
  let resolverWorkdir = '';
  let started: StartStudioHostOptions | undefined;

  await runStudioHostApplication({
    workdir: './project',
    transport: { kind: 'stdio' },
  }, {
    buildRuntimeConfig: () => config,
    createModuleResolver: (options) => {
      resolverWorkdir = options.workdir;
      return resolver;
    },
    startStdio: async (options) => {
      started = options;
      return completedHost();
    },
    signals: new EventEmitter(),
  });

  assert.equal(resolverWorkdir, '/resolved/project');
  assert.equal(started?.runtimeConfig, config);
  assert.equal(started?.resolveModule, resolver);
});

test('Studio application closes the WebSocket Host on SIGTERM', async () => {
  const signals = new EventEmitter();
  let closeCount = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let startedPort = 0;
  const running = runStudioHostApplication({
    transport: { kind: 'websocket', port: 4321 },
  }, {
    buildRuntimeConfig: () => runtimeConfig('/resolved/project'),
    createModuleResolver: () => async () => ({
      plugin: {} as Awaited<ReturnType<StudioModuleResolver>>['plugin'],
    }),
    startWebSocket: async (port) => {
      startedPort = port;
      return {
        host: {} as RunningStudioHost['host'],
        close: () => {
          closeCount += 1;
          resolveClosed();
        },
        closed,
      };
    },
    signals,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  signals.emit('SIGTERM');
  signals.emit('SIGTERM');
  await running;

  assert.equal(startedPort, 4321);
  assert.equal(closeCount, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('Studio application remembers a close signal received during Host startup', async () => {
  const signals = new EventEmitter();
  let releaseStart!: (host: RunningStudioHost) => void;
  const starting = new Promise<RunningStudioHost>((resolve) => { releaseStart = resolve; });
  let closeCount = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const application = runStudioHostApplication({
    transport: { kind: 'stdio' },
  }, {
    buildRuntimeConfig: () => runtimeConfig('/resolved/project'),
    createModuleResolver: () => async () => ({
      plugin: {} as Awaited<ReturnType<StudioModuleResolver>>['plugin'],
    }),
    startStdio: async () => starting,
    signals,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  signals.emit('SIGINT');
  assert.equal(closeCount, 0);

  releaseStart({
    host: {} as RunningStudioHost['host'],
    close: () => {
      closeCount += 1;
      resolveClosed();
    },
    closed,
  });
  await application;

  assert.equal(closeCount, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
