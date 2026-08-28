import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const [{ initStudioKickstart }, transport] = await Promise.all([
  import('@pinpawo/studio'),
  import('pinpawo/local-server-transport'),
]);
const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-hello-'));
// npm can terminate its whole foreground process group on Ctrl-C before this
// module's async finally has time to finish. Keep a synchronous process-exit
// fallback so the disposable demo never strands checkpoints or generated
// project files. The normal async cleanup below remains the primary path.
const cleanupWorkdirOnExit = () => {
  rmSync(workdir, { recursive: true, force: true });
};
process.once('exit', cleanupWorkdirOnExit);
await initStudioKickstart({ workdir });

const previousToken = transport.readLocalServerAuthToken();
const triggerSecret = process.env.PINPAWO_HELLO_TRIGGER_SECRET
  ?? randomBytes(24).toString('base64url');
const environment = {
  ...process.env,
  PINPAWO_HELLO_TRIGGER_SECRET: triggerSecret,
};
const processes = [
  {
    label: 'Studio Host',
    child: spawn(process.execPath, [npmCli, 'run', 'start', '-w', '@pinpawo/studio', '--',
      '--workdir', workdir, '--pet-port', '3210'], {
      cwd: workspaceRoot,
      env: environment,
      stdio: 'inherit',
    }),
  },
  {
    label: 'Studio Console',
    child: spawn(process.execPath, [npmCli, 'run', 'dev', '-w', '@pinpawo/studio-console', '--',
      '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
      cwd: workspaceRoot,
      env: environment,
      stdio: 'inherit',
    }),
  },
];

let closing = false;
let terminationSettled = false;
let settleTermination;
const termination = new Promise((resolve) => { settleTermination = resolve; });

function closeChildren(signal = 'SIGTERM') {
  if (closing) return;
  closing = true;
  for (const { child } of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(process.platform === 'win32' ? undefined : signal);
    }
  }
}

function settle(result) {
  if (terminationSettled) return;
  terminationSettled = true;
  settleTermination(result);
}

function fail(error) {
  if (terminationSettled) return;
  process.exitCode = 1;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  settle({ kind: 'failure' });
  closeChildren();
}

const completions = processes.map(({ child, label }) => new Promise((resolve) => {
  let completed = false;
  const complete = () => {
    if (completed) return;
    completed = true;
    resolve();
  };
  child.once('error', (error) => {
    if (!closing) fail(new Error(`${label} failed to start: ${String(error)}`));
    complete();
  });
  child.once('exit', (code, signal) => {
    if (!closing) {
      fail(new Error(`${label} exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`));
    }
    complete();
  });
}));

const stopForSignal = (signal) => {
  settle({ kind: 'signal' });
  closeChildren(signal);
};
const onSigint = () => stopForSignal('SIGINT');
const onSigterm = () => stopForSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

async function endpointReady(url, token) {
  try {
    const response = await fetch(url, {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      signal: AbortSignal.timeout(1_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReady() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (closing) throw new Error('Studio Hello World stopped before becoming ready.');
    const token = transport.readLocalServerAuthToken();
    if (token && token !== previousToken) {
      const [studioReady, consoleReady] = await Promise.all([
        endpointReady('http://127.0.0.1:3211/pets', token),
        endpointReady('http://127.0.0.1:5173/', null),
      ]);
      if (studioReady && consoleReady) return token;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Studio Hello World did not become ready within 60 seconds.');
}

try {
  const startup = await Promise.race([
    waitForReady().then((token) => ({ kind: 'ready', token })),
    termination,
  ]);
  if (startup.kind === 'ready') {
    process.stdout.write([
      '',
      'Studio Hello World ready',
      `  Runtime workdir: ${workdir}`,
      '  Console:         http://127.0.0.1:5173',
      '  Studio HTTP:     http://127.0.0.1:3211',
      '  Pet TUI:         pinpawo tui --pet-port 3210 --pet-id planner',
      `  Bearer token:    ${startup.token}`,
      `  Trigger secret:  ${triggerSecret}`,
      '',
    ].join('\n'));
    await termination;
  }
} catch (error) {
  fail(error);
  await termination;
} finally {
  closeChildren();
  await Promise.all(completions);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  await rm(workdir, { recursive: true, force: true });
  process.off('exit', cleanupWorkdirOnExit);
}
