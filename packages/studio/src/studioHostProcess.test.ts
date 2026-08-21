import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { LocalAgentRuntimeConfig } from 'pinpawo/host-runtime';
import type { StudioModuleResolver } from './host/buildStudio';
import type { RunningStudioHost, StartStudioHostOptions } from './startStudioHost';
import { runStudioHostProcess } from './studioHostProcess';

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

test('Studio Host process composes resolver before starting stdio', async () => {
  const config = runtimeConfig('/resolved/project');
  const resolver: StudioModuleResolver = async () => ({
    plugin: {} as Awaited<ReturnType<StudioModuleResolver>>['plugin'],
  });
  let started: StartStudioHostOptions | undefined;

  await runStudioHostProcess({
    workdir: './project',
    resolveModule: resolver,
    transport: { kind: 'stdio' },
  }, {
    buildRuntimeConfig: () => config,
    startStdio: async (options) => {
      started = options;
      return completedHost();
    },
    signals: new EventEmitter(),
  });

  assert.equal(started?.runtimeConfig, config);
  assert.equal(started?.resolveModule, resolver);
});

test('Studio Host process closes the WebSocket Host on SIGTERM', async () => {
  const signals = new EventEmitter();
  let closeCount = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let startedPort = 0;
  const running = runStudioHostProcess({
    transport: { kind: 'websocket', port: 4321 },
  }, {
    buildRuntimeConfig: () => runtimeConfig('/resolved/project'),
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

test('Studio Host process remembers a close signal received during startup', async () => {
  const signals = new EventEmitter();
  let releaseStart!: (host: RunningStudioHost) => void;
  const starting = new Promise<RunningStudioHost>((resolve) => { releaseStart = resolve; });
  let closeCount = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const processRun = runStudioHostProcess({
    transport: { kind: 'stdio' },
  }, {
    buildRuntimeConfig: () => runtimeConfig('/resolved/project'),
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
  await processRun;

  assert.equal(closeCount, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
