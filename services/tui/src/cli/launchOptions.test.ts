import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTuiLaunchOptions } from './launchOptions';

test('launch options keep production mode free of demo transports', () => {
  assert.deepEqual(parseTuiLaunchOptions([]), {
    showVersion: false,
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
