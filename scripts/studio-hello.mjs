import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workdir = path.join(workspaceRoot, 'packages', 'studio', 'examples', 'kanban-workdir');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run the Studio Hello World through npm.');

function runNpm(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (code=${String(code)}, signal=${String(signal)}).`));
    });
  });
}

if (process.env.PINPAWO_STUDIO_HELLO_SKIP_BUILD !== '1') {
  await runNpm(['run', 'build'], 'Studio Hello World build');
}

const transport = await import('pinpawo/local-server-transport');
const previousToken = transport.readLocalServerAuthToken();
const triggerSecret = process.env.PINPAWO_HELLO_TRIGGER_SECRET
  ?? randomBytes(24).toString('base64url');
const environment = {
  ...process.env,
  PINPAWO_HELLO_TRIGGER_SECRET: triggerSecret,
};
const children = [
  spawn(process.execPath, [npmCli, 'run', 'start', '-w', '@pinpawo/studio', '--',
    '--workdir', workdir, '--pet-port', '3210'], {
    cwd: workspaceRoot,
    env: environment,
    stdio: 'inherit',
  }),
  spawn(process.execPath, [npmCli, 'run', 'dev', '-w', '@pinpawo/studio-console', '--',
    '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    cwd: workspaceRoot,
    env: environment,
    stdio: 'inherit',
  }),
];

let closing = false;
const close = (signal = 'SIGTERM') => {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
};
process.once('SIGINT', () => close('SIGINT'));
process.once('SIGTERM', () => close('SIGTERM'));

let settleTerminated;
const terminated = new Promise((resolve) => { settleTerminated = resolve; });
let settled = false;
for (const child of children) {
  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    close();
    settleTerminated();
  });
  child.once('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    if (!closing && code !== 0) {
      process.stderr.write(`Studio Hello World process exited (code=${String(code)}, signal=${String(signal)}).\n`);
      process.exitCode = 1;
    }
    close();
    settleTerminated();
  });
}

async function waitForFreshToken() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const token = transport.readLocalServerAuthToken();
    if (token && token !== previousToken) return token;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return transport.readLocalServerAuthToken();
}

const readiness = await Promise.race([
  waitForFreshToken().then((token) => ({ kind: 'ready', token })),
  terminated.then(() => ({ kind: 'terminated' })),
]);
if (readiness.kind === 'ready') {
  process.stdout.write([
    '',
    'Studio Hello World',
    '  Console:      http://127.0.0.1:5173',
    '  Studio HTTP:  http://127.0.0.1:3211',
    '  Pet TUI:      pinpawo tui --pet-port 3210 --pet-id planner',
    `  Bearer token: ${readiness.token ?? '(read ~/.pinpawo/local-server-token)'}`,
    `  Trigger secret: ${triggerSecret}`,
    '',
  ].join('\n'));
}
await terminated;
