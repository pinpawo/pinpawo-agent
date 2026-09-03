import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __testOnly,
  launchStudioTmux,
  openStudioConsole,
} from './studioCliLaunchers';

test('Studio Console opens the platform browser after confirming the Console server is ready', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  await openStudioConsole({ url: 'http://127.0.0.1:5176' }, {
    platform: 'darwin',
    probeConsole: async () => true,
    runOpenCommand: async (command, args) => { calls.push({ command, args }); },
  });
  assert.deepEqual(calls, [{ command: 'open', args: ['http://127.0.0.1:5176'] }]);
});

test('Studio Console starts an unavailable local server before opening the browser', async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let probes = 0;
  let starts = 0;
  await openStudioConsole({}, {
    platform: 'darwin',
    probeConsole: async () => {
      probes += 1;
      return probes > 1;
    },
    startConsole: () => { starts += 1; },
    wait: async () => {},
    runOpenCommand: async (command, args) => { calls.push({ command, args }); },
  });
  assert.equal(starts, 1);
  assert.deepEqual(calls, [{ command: 'open', args: ['http://127.0.0.1:5173'] }]);
});

test('Studio tmux connects configured Pet TUIs without starting the Host', async () => {
  const calls: string[][] = [];
  const opened: string[] = [];
  await launchStudioTmux({
    agentSessionPort: 4321,
    sessionName: 'demo',
    detached: true,
    openConsole: true,
  }, {
    discoverPetIds: async (url) => {
      assert.equal(url, 'http://127.0.0.1:3211');
      return ['planner', 'reviewer'];
    },
    runTmux: async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') throw new Error('missing');
      if (args[0] === 'new-session') return { stdout: '%7\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    openConsole: async ({ url }) => { opened.push(url ?? ''); },
    petCliPath: '/bin/pinpawo',
    nodePath: '/usr/local/bin/node',
    writeOutput: () => {},
  });

  assert.deepEqual(calls[1], [
    'new-session', '-d', '-s', 'demo', '-n', 'pets',
    "exec '/usr/local/bin/node' '/bin/pinpawo' 'tui' '--pet-port' '4321' '--pet-id' 'planner'",
  ]);
  assert.ok(calls.some((args) => args[0] === 'split-window' && args.at(-1)?.includes("'reviewer'")));
  assert.ok(calls.every((args) => !args.at(-1)?.includes("'start'")));
  assert.deepEqual(opened, ['']);
});

test('Studio tmux uses explicit Pet ids without calling the Studio HTTP endpoint', async () => {
  const calls: string[][] = [];
  await launchStudioTmux({
    agentSessionPort: 4321,
    petIds: ['planner', 'wiki'],
    detached: true,
  }, {
    discoverPetIds: async () => assert.fail('explicit Pet ids must skip discovery'),
    runTmux: async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') throw new Error('missing');
      if (args[0] === 'new-session') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    petCliPath: '/bin/pinpawo',
    nodePath: '/usr/local/bin/node',
    writeOutput: () => {},
  });
  assert.ok(calls.some((args) => args.at(-1)?.includes("'planner'")));
  assert.ok(calls.some((args) => args.at(-1)?.includes("'wiki'")));
});

test('Studio tmux returns an attach instruction instead of failing without a terminal', async () => {
  const calls: string[][] = [];
  let output = '';
  await launchStudioTmux({
    agentSessionPort: 4321,
    petIds: ['planner'],
  }, {
    runTmux: async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') throw new Error('missing');
      if (args[0] === 'new-session') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    petCliPath: '/bin/pinpawo',
    nodePath: '/usr/local/bin/node',
    interactive: false,
    writeOutput: (text) => { output += text; },
  });
  assert.match(output, /tmux attach-session -t pinpawo-studio/);
  assert.ok(!calls.some((args) => args[0] === 'attach-session'));
});

test('Studio tmux treats a failed interactive attach as a ready background session', async () => {
  const calls: string[][] = [];
  let output = '';
  await launchStudioTmux({
    agentSessionPort: 4321,
    petIds: ['planner'],
  }, {
    runTmux: async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') throw new Error('missing');
      if (args[0] === 'new-session') return { stdout: '', stderr: '' };
      if (args[0] === 'attach-session') throw new Error('not a terminal');
      return { stdout: '', stderr: '' };
    },
    petCliPath: '/bin/pinpawo',
    nodePath: '/usr/local/bin/node',
    interactive: true,
    writeOutput: (text) => { output += text; },
  });
  assert.match(output, /Studio tmux session ready/);
  assert.ok(calls.some((args) => args[0] === 'attach-session'));
});

test('Studio tmux escaping keeps paths and Pet ids as individual shell arguments', () => {
  assert.equal(
    __testOnly.commandLine('/path with spaces/node', ["one'two", 'three']),
    "exec '/path with spaces/node' 'one'\\''two' 'three'",
  );
});

test('Studio tmux accepts only an HTTP origin for Studio discovery', () => {
  assert.equal(__testOnly.normalizeStudioUrl('http://127.0.0.1:3211'), 'http://127.0.0.1:3211');
  assert.throws(
    () => __testOnly.normalizeStudioUrl('http://127.0.0.1:3211/pets'),
    /origin without credentials, path, query, or fragment/,
  );
});
