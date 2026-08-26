import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { LocalAgentRuntimeConfig } from 'pinpawo/host-runtime';
import type { StudioPluginResolver } from './host/buildStudio';
import type { RunningStudioHost, StartStudioHostOptions } from './startStudioHost';
import { runStudioHostProcess } from './studioHostProcess';

function runtimeConfig(workdir: string): LocalAgentRuntimeConfig {
  return { workdir } as LocalAgentRuntimeConfig;
}

function completedHost(): RunningStudioHost {
  return {
    host: {} as RunningStudioHost['host'],
    agentSessionPort: 0,
    close: () => undefined,
    closed: Promise.resolve(),
  };
}

test('Studio Host process composes resolver and Agent Session port before starting', async () => {
  const config = runtimeConfig('/resolved/project');
  const resolver: StudioPluginResolver = async () => ({
    name: 'test',
    toolkits: [],
    start: () => undefined,
  });
  let started: StartStudioHostOptions | undefined;

  await runStudioHostProcess({
    workdir: './project',
    resolvePlugin: resolver,
    agentSessionPort: 4321,
  }, {
    buildRuntimeConfig: () => config,
    ensureAuthToken: () => 'test-auth-token',
    startHost: async (options) => {
      started = options;
      return completedHost();
    },
    signals: new EventEmitter(),
  });

  assert.equal(started?.runtimeConfig, config);
  assert.equal(started?.resolvePlugin, resolver);
  assert.equal(started?.agentSessionPort, 4321);
  assert.equal(started?.agentSessionTransport?.authToken, 'test-auth-token');
});

test('Studio Host process installs the package resolver for the standalone CLI', async () => {
  const config = runtimeConfig('/resolved/project');
  const resolver: StudioPluginResolver = async () => ({
    name: 'installed',
    toolkits: [],
    start: () => undefined,
  });
  let resolverWorkdir = '';
  let started: StartStudioHostOptions | undefined;

  await runStudioHostProcess({}, {
    buildRuntimeConfig: () => config,
    ensureAuthToken: () => 'test-auth-token',
    createPluginResolver: (options) => {
      resolverWorkdir = options.workdir;
      return resolver;
    },
    startHost: async (options) => {
      started = options;
      return completedHost();
    },
    signals: new EventEmitter(),
  });

  assert.equal(resolverWorkdir, '/resolved/project');
  assert.equal(started?.resolvePlugin, resolver);
});

test('Studio Host process closes the Host on SIGTERM', async () => {
  const signals = new EventEmitter();
  let closeCount = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const running = runStudioHostProcess({}, {
    buildRuntimeConfig: () => runtimeConfig('/resolved/project'),
    ensureAuthToken: () => 'test-auth-token',
    startHost: async () => {
      return {
        host: {} as RunningStudioHost['host'],
        agentSessionPort: 4321,
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

  const processRun = runStudioHostProcess({}, {
    buildRuntimeConfig: () => runtimeConfig('/resolved/project'),
    ensureAuthToken: () => 'test-auth-token',
    startHost: async () => starting,
    signals,
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  signals.emit('SIGINT');
  assert.equal(closeCount, 0);

  releaseStart({
    host: {} as RunningStudioHost['host'],
    agentSessionPort: 43123,
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
