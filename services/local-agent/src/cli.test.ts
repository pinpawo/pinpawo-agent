import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalAgentCli } from './cli';

test('local agent CLI passes tui options to the handler', async () => {
  let received: { dryRun: boolean } | null = null;
  const program = createLocalAgentCli({
    runTui: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['tui', '--dry-run'], { from: 'user' });

  assert.deepEqual(received, { dryRun: true });
});

test('local agent CLI passes once options to the handler', async () => {
  let received: { dryRun: boolean; noDb: boolean } | null = null;
  const program = createLocalAgentCli({
    runOnce: (options) => {
      received = options;
    },
  });

  await program.parseAsync(['once', '--dry-run', '--no-db'], { from: 'user' });

  assert.deepEqual(received, { dryRun: true, noDb: true });
});
