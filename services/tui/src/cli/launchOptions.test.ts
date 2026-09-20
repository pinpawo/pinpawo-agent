import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseTuiLaunchOptions,
  readEmbeddedHostTarget,
} from './launchOptions';

test('launch options default production mode to the embedded stdio Host', () => {
  assert.deepEqual(parseTuiLaunchOptions([]), {
    showVersion: false,
    agentSession: null,
    serverPort: null,
    embeddedHost: { command: 'pinpawo', args: ['run', '--stdio'] },
    demo: {
      command: false,
      qa: false,
      review: false,
    },
    smoke: {
      base: false,
      command: false,
      edit: false,
      hostChat: false,
      hostReady: false,
      policy: false,
      review: false,
      transcript: false,
    },
    smokeEnabled: false,
    hostSmoke: false,
    useDemoConnection: false,
  });
});

test('launch options select one Pet-scoped Agent Session endpoint', () => {
  const pet = parseTuiLaunchOptions([
    '--pet-port',
    '4322',
    '--pet-id',
    'planner',
  ]);
  assert.deepEqual(pet.agentSession, { port: 4322, petId: 'planner' });
  // Studio launches the client this way; it must keep dialing the resident Pet
  // instead of embedding a Host of its own.
  assert.equal(pet.embeddedHost, null);
  assert.equal(pet.serverPort, null);
  assert.throws(
    () => parseTuiLaunchOptions(['--pet-id', 'planner']),
    /provided together/,
  );
});

test('launch options distinguish deterministic and real-host smokes', () => {
  const deterministic = parseTuiLaunchOptions(['--smoke-review']);
  assert.equal(deterministic.smoke.review, true);
  assert.equal(deterministic.smokeEnabled, true);
  assert.equal(deterministic.useDemoConnection, true);

  const host = parseTuiLaunchOptions(['--smoke-host-chat']);
  assert.equal(host.smoke.hostChat, true);
  assert.equal(host.hostSmoke, true);
  assert.equal(host.useDemoConnection, false);
});

test('launch options expose interactive demos and version mode', () => {
  const options = parseTuiLaunchOptions([
    '--version',
    '--demo-command',
    '--demo-qa',
  ]);
  assert.equal(options.showVersion, true);
  assert.equal(options.demo.command, true);
  assert.equal(options.demo.qa, true);
  assert.equal(options.useDemoConnection, true);
});

test('launch options take the embedded Host command from the launcher contract', () => {
  const options = parseTuiLaunchOptions(['--embed-host'], {
    PINPAWO_EMBED_HOST_COMMAND: '/usr/local/bin/node',
    PINPAWO_EMBED_HOST_ARGS: JSON.stringify([
      '/app/node_modules/pinpawo/dist/index.js',
      'run',
      '--stdio',
    ]),
  });

  assert.deepEqual(options.embeddedHost, {
    command: '/usr/local/bin/node',
    args: ['/app/node_modules/pinpawo/dist/index.js', 'run', '--stdio'],
  });
  assert.equal(options.agentSession, null);
  assert.equal(options.useDemoConnection, false);
});

test('launch options keep the embedded Host on by default', () => {
  const options = parseTuiLaunchOptions([], {
    PINPAWO_EMBED_HOST_COMMAND: '/usr/local/bin/node',
    PINPAWO_EMBED_HOST_ARGS: JSON.stringify(['/app/pinpawo/dist/index.js', 'run', '--stdio']),
  });
  assert.deepEqual(options.embeddedHost, {
    command: '/usr/local/bin/node',
    args: ['/app/pinpawo/dist/index.js', 'run', '--stdio'],
  });
  assert.equal(options.serverPort, null);
});

test('launch options dial a running Host only when --server-port names one', () => {
  const options = parseTuiLaunchOptions(['--server-port', '4321'], {
    PINPAWO_EMBED_HOST_COMMAND: '/usr/local/bin/node',
  });

  assert.equal(options.serverPort, 4321);
  assert.equal(options.embeddedHost, null);
  assert.equal(options.agentSession, null);
  assert.equal(options.useDemoConnection, false);
  assert.throws(
    () => parseTuiLaunchOptions(['--server-port', '0']),
    /--server-port must be an integer from 1 to 65535/,
  );
  assert.throws(
    () => parseTuiLaunchOptions(['--server-port']),
    /--server-port requires a value/,
  );
});

test('launch options reject competing embedded and connect targets', () => {
  assert.throws(
    () => parseTuiLaunchOptions(['--embed-host', '--server-port', '4321']),
    /--embed-host and --server-port are mutually exclusive/,
  );
  assert.throws(
    () => parseTuiLaunchOptions(['--embed-host', '--pet-port', '4322', '--pet-id', 'planner']),
    /--embed-host cannot be combined with --pet-port/,
  );
  assert.throws(
    () => parseTuiLaunchOptions(['--server-port', '4321', '--pet-port', '4322', '--pet-id', 'planner']),
    /--server-port cannot be combined with --pet-port/,
  );
});

test('launch options keep the read-only and demo modes off the embedded Host', () => {
  assert.equal(
    parseTuiLaunchOptions(['--version'], {
      PINPAWO_EMBED_HOST_COMMAND: '/usr/local/bin/node',
    }).embeddedHost,
    null,
  );
  assert.equal(parseTuiLaunchOptions(['--demo-qa']).embeddedHost, null);
});

test('host smokes keep attaching to a separately started Host', () => {
  const options = parseTuiLaunchOptions(['--smoke-host-chat'], {
    PINPAWO_EMBED_HOST_COMMAND: '/usr/local/bin/node',
  });

  assert.equal(options.hostSmoke, true);
  assert.equal(options.useDemoConnection, false);
  assert.equal(options.embeddedHost, null);
});

test('embedded Host target falls back to the pinpawo executable on PATH', () => {
  assert.deepEqual(readEmbeddedHostTarget({}), {
    command: 'pinpawo',
    args: ['run', '--stdio'],
  });
  assert.deepEqual(readEmbeddedHostTarget({
    PINPAWO_EMBED_HOST_COMMAND: '  ',
    PINPAWO_EMBED_HOST_ARGS: '  ',
  }), {
    command: 'pinpawo',
    args: ['run', '--stdio'],
  });
});

test('embedded Host arguments reject a value the launcher cannot have written', () => {
  assert.throws(
    () => readEmbeddedHostTarget({ PINPAWO_EMBED_HOST_ARGS: 'run --stdio' }),
    /PINPAWO_EMBED_HOST_ARGS must be a JSON array/,
  );
  assert.throws(
    () => readEmbeddedHostTarget({ PINPAWO_EMBED_HOST_ARGS: '["run",7]' }),
    /PINPAWO_EMBED_HOST_ARGS must be a JSON array/,
  );
});
