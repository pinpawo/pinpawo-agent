import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readLocalServerAuthToken } from 'pinpawo/local-server-transport';

const execFileAsync = promisify(execFile);

export const DEFAULT_STUDIO_CONSOLE_URL = 'http://127.0.0.1:5173';
export const DEFAULT_STUDIO_HTTP_URL = 'http://127.0.0.1:3211';
export const DEFAULT_STUDIO_TMUX_SESSION = 'pinpawo-studio';

export type StudioConsoleOptions = {
  url?: string;
};

export type StudioTmuxOptions = {
  agentSessionPort: number;
  petIds?: string[];
  studioUrl?: string;
  sessionName?: string;
  detached?: boolean;
  reset?: boolean;
  openConsole?: boolean;
  consoleUrl?: string;
};

type TmuxResult = {
  stdout: string;
  stderr: string;
};

export type StudioTmuxLauncherDependencies = {
  discoverPetIds?: (studioUrl: string) => Promise<string[]>;
  runTmux?: (args: string[]) => Promise<TmuxResult>;
  openConsole?: (options: StudioConsoleOptions) => Promise<void> | void;
  petCliPath?: string;
  nodePath?: string;
  insideTmux?: boolean;
  interactive?: boolean;
  writeOutput?: (text: string) => void;
};

export type StudioConsoleLauncherDependencies = {
  platform?: NodeJS.Platform;
  runOpenCommand?: (command: string, args: string[]) => Promise<void>;
  probeConsole?: (url: string) => Promise<boolean>;
  startConsole?: (url: string) => Promise<void> | void;
  wait?: (milliseconds: number) => Promise<void>;
};

function nonEmpty(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandLine(command: string, args: string[]): string {
  return ['exec', shellQuote(command), ...args.map(shellQuote)].join(' ');
}

function requiredPetCliPath(): string {
  return fileURLToPath(import.meta.resolve('pinpawo'));
}

function normalizeStudioUrl(value: string | undefined): string {
  const url = new URL(nonEmpty(value, DEFAULT_STUDIO_HTTP_URL));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--studio-url must be an HTTP(S) URL.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--studio-url must be an origin without credentials, path, query, or fragment.');
  }
  return url.origin;
}

function normalizeConsoleUrl(value: string | undefined): URL {
  const url = new URL(nonEmpty(value, DEFAULT_STUDIO_CONSOLE_URL));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('--url must be an HTTP(S) URL.');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('--url must be an origin without credentials, path, query, or fragment.');
  }
  return url;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function consoleWorkspaceRoot(): string {
  let candidate = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 6; index += 1) {
    if (existsSync(join(candidate, 'apps', 'studio-console', 'package.json'))) return candidate;
    candidate = dirname(candidate);
  }
  throw new Error(
    'Studio Console is not installed beside this Studio CLI. Run this command from a PinPawo source checkout, or start a separately deployed Console and pass its --url.',
  );
}

async function probeStudioConsole(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForStudioConsole(
  url: string,
  probe: (url: string) => Promise<boolean>,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probe(url)) return;
    await wait(100);
  }
  throw new Error(`Studio Console did not become ready at ${url}.`);
}

function startStudioConsole(url: string): void {
  const target = normalizeConsoleUrl(url);
  if (!isLoopbackHost(target.hostname)) {
    throw new Error(`Studio Console is unavailable at ${url}; only a loopback Console URL can be started locally.`);
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  const child = spawn(npmCommand, [
    'run',
    'dev',
    '-w',
    '@pinpawo/studio-console',
    '--',
    '--host',
    target.hostname,
    '--port',
    port,
    '--strictPort',
  ], {
    cwd: consoleWorkspaceRoot(),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function uniquePetIds(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const petId = value.trim();
    if (!petId) throw new Error('--pet must be a non-empty Pet id.');
    if (!result.includes(petId)) result.push(petId);
  }
  if (result.length === 0) throw new Error('Studio tmux needs at least one Pet.');
  return result;
}

async function discoverStudioPetIds(studioUrl: string): Promise<string[]> {
  const token = readLocalServerAuthToken();
  if (!token) {
    throw new Error('Studio bearer token is unavailable. Use --pet to name Pet TUI clients directly.');
  }
  let response: Response;
  try {
    response = await fetch(new URL('/pets', studioUrl), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch (error) {
    throw new Error(
      `Unable to discover Studio Pets from ${studioUrl}: ${error instanceof Error ? error.message : String(error)}. Use --pet to name Pet TUI clients directly.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Studio Pet discovery at ${studioUrl}/pets failed (${response.status.toString()}). Use --pet to name Pet TUI clients directly.`,
    );
  }
  const payload = await response.json() as { pets?: unknown };
  if (!Array.isArray(payload.pets)) {
    throw new Error(`Studio Pet discovery at ${studioUrl}/pets returned an invalid payload.`);
  }
  return uniquePetIds(payload.pets.flatMap((pet) => (
    pet && typeof pet === 'object' && typeof (pet as { petId?: unknown }).petId === 'string'
      ? [(pet as { petId: string }).petId]
      : []
  )));
}

async function runTmux(args: string[]): Promise<TmuxResult> {
  const result = await execFileAsync('tmux', args, { encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function tmuxSessionExists(run: (args: string[]) => Promise<TmuxResult>, sessionName: string) {
  try {
    await run(['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

function isInteractiveTerminal(value: boolean | undefined): boolean {
  return value ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function reportSessionReady(
  sessionName: string,
  writeOutput: (text: string) => void,
): void {
  writeOutput(`Studio tmux session ready: ${sessionName}\nAttach with: tmux attach-session -t ${sessionName}\n`);
}

async function attachSessionOrReport(
  run: (args: string[]) => Promise<TmuxResult>,
  sessionName: string,
  insideTmux: boolean,
  writeOutput: (text: string) => void,
): Promise<void> {
  try {
    await run([
      insideTmux ? 'switch-client' : 'attach-session',
      '-t',
      sessionName,
    ]);
  } catch {
    // Some embedded terminal surfaces report isTTY but cannot provide tmux a
    // controlling terminal. The background session is still valid.
    reportSessionReady(sessionName, writeOutput);
  }
}

function openingCommand(platform: NodeJS.Platform): { command: string; args: (url: string) => string[] } {
  if (platform === 'darwin') return { command: 'open', args: (url) => [url] };
  if (platform === 'win32') return { command: 'cmd', args: (url) => ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: (url) => [url] };
}

/** Ensure the separately served Studio Console is running, then open it in the user's default browser. */
export async function openStudioConsole(
  options: StudioConsoleOptions = {},
  dependencies: StudioConsoleLauncherDependencies = {},
): Promise<void> {
  const url = normalizeConsoleUrl(options.url).origin;
  const probe = dependencies.probeConsole ?? probeStudioConsole;
  if (!await probe(url)) {
    await (dependencies.startConsole ?? startStudioConsole)(url);
    await waitForStudioConsole(url, probe, dependencies.wait ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    })));
  }
  const opening = openingCommand(dependencies.platform ?? process.platform);
  if (dependencies.runOpenCommand) {
    await dependencies.runOpenCommand(opening.command, opening.args(url));
    return;
  }
  await execFileAsync(opening.command, opening.args(url), { encoding: 'utf8' });
}

/**
 * Build a tiled TUI layout for an already-running Studio Host. It does not
 * own the Host process or its workdir; the Host remains the single runtime
 * owner and publishes the Agent Session port supplied here.
 */
export async function launchStudioTmux(
  options: StudioTmuxOptions,
  dependencies: StudioTmuxLauncherDependencies = {},
): Promise<void> {
  const sessionName = nonEmpty(options.sessionName, DEFAULT_STUDIO_TMUX_SESSION);
  const run = dependencies.runTmux ?? runTmux;
  const interactive = isInteractiveTerminal(dependencies.interactive);
  const writeOutput = dependencies.writeOutput ?? process.stdout.write.bind(process.stdout);
  const sessionExists = await tmuxSessionExists(run, sessionName);
  if (sessionExists && !options.reset) {
    if (options.openConsole) {
      await (dependencies.openConsole ?? openStudioConsole)({ url: options.consoleUrl });
    }
    if (options.detached || !interactive) {
      reportSessionReady(sessionName, writeOutput);
    } else {
      await attachSessionOrReport(
        run,
        sessionName,
        dependencies.insideTmux ?? Boolean(process.env.TMUX),
        writeOutput,
      );
    }
    return;
  }
  if (sessionExists) await run(['kill-session', '-t', sessionName]);

  const studioUrl = normalizeStudioUrl(options.studioUrl);
  const petIds = options.petIds?.length
    ? uniquePetIds(options.petIds)
    : await (dependencies.discoverPetIds ?? discoverStudioPetIds)(studioUrl);
  const petCliPath = dependencies.petCliPath ?? requiredPetCliPath();
  const nodePath = dependencies.nodePath ?? process.execPath;
  const petCommand = (petId: string) => commandLine(nodePath, [
    petCliPath,
    'tui',
    '--pet-port',
    options.agentSessionPort.toString(),
    '--pet-id',
    petId,
  ]);
  const firstPet = petIds[0];
  if (!firstPet) throw new Error('Studio tmux needs at least one Pet.');
  const firstPane = await run([
    'new-session',
    '-d',
    '-s',
    sessionName,
    '-n',
    'pets',
    petCommand(firstPet),
  ]);
  for (const petId of petIds.slice(1)) {
    await run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${sessionName}:pets`, petCommand(petId)]);
  }
  await run(['select-layout', '-t', `${sessionName}:pets`, 'tiled']);
  await run(['set-option', '-t', sessionName, 'mouse', 'on']);
  await run(['set-window-option', '-t', `${sessionName}:pets`, 'remain-on-exit', 'on']);
  const paneId = firstPane.stdout.trim();
  if (paneId) await run(['select-pane', '-t', paneId]);
  if (options.openConsole) {
    await (dependencies.openConsole ?? openStudioConsole)({ url: options.consoleUrl });
  }
  if (options.detached || !interactive) {
    reportSessionReady(sessionName, writeOutput);
    return;
  }
  await attachSessionOrReport(
    run,
    sessionName,
    dependencies.insideTmux ?? Boolean(process.env.TMUX),
    writeOutput,
  );
}

export const __testOnly = {
  commandLine,
  isInteractiveTerminal,
  normalizeStudioUrl,
  openingCommand,
  shellQuote,
};
