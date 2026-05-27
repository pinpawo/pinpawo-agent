#!/usr/bin/env node

const command = process.argv[2] ?? 'run';
const dryRun = process.argv.includes('--dry-run');
const noDb = process.argv.includes('--no-db');

if (command === 'login') {
  const { runLogin } = await import('./commands/login');
  await runLogin();
} else if (command === 'actor') {
  const { runActorSelect } = await import('./actorSelection');
  await runActorSelect();
} else if (command === 'run') {
  const { runAgent } = await import('./commands/run');
  await runAgent();
} else if (command === 'once') {
  const { runOnce } = await import('./commands/once');
  await runOnce({ dryRun, noDb });
} else if (command === 'tui') {
  const { runTui } = await import('./commands/tui');
  await runTui({ dryRun });
} else if (command === 'detect') {
  const { runDetect } = await import('./commands/detect');
  await runDetect();
} else if (command === 'capability') {
  const { runCapabilityCommand } = await import('./commands/capability');
  await runCapabilityCommand(process.argv.slice(3));
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Usage: pinpawo-agent <login|actor|run|once|tui|detect|capability> [--dry-run] [--no-db]');
  process.exit(1);
}

export {};
