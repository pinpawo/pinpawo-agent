import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { Command } from 'commander';
import { registerCapabilityCommand } from './commands/capability';
import type { InitCommandOptions } from './commands/init';
import { readLocalAgentPackageVersion } from './packageVersion';

type LocalAgentCliHandlers = {
  runLogin?: () => Promise<void> | void;
  runActorSelect?: () => Promise<void> | void;
  runAgent?: (opts: { workdir?: string; stdio: boolean }) => Promise<void> | void;
  runTui?: (opts: { dryRun: boolean; workdir?: string }) => Promise<void> | void;
  runDetect?: () => Promise<void> | void;
  runInit?: (opts: InitCommandOptions) => Promise<void> | void;
  runSetup?: (opts: { workdir?: string }) => Promise<void> | void;
  runBrowser?: (
    target: string,
    action: string,
    opts: { extensionId?: string },
  ) => Promise<void> | void;
};

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function readExitCode(error: unknown): number {
  const value = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function resolveWorkdirOption(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

export function createLocalAgentCli(handlers: LocalAgentCliHandlers = {}): Command {
  const program = new Command();
  program
    .name('pinpawo')
    .description('PinPawo local agent CLI')
    .version(readLocalAgentPackageVersion());

  program
    .command('init')
    .description('Scaffold local config and an example capability for a quick install')
    .option('--dir <directory>', 'target PinPawo config directory', '~/.pinpawo')
    .option('--force', 'overwrite generated scaffold files')
    .option('--no-example-capability', 'skip the generated example capability')
    .action(async (options: { dir?: string; force?: boolean; exampleCapability?: boolean }) => {
      const runInit = handlers.runInit ?? (await import('./commands/init')).runInit;
      await runInit({
        dir: options.dir,
        force: options.force ?? false,
        exampleCapability: options.exampleCapability ?? true,
      });
    });

  program
    .command('setup')
    .description('Check local configuration and print guided setup steps')
    .option('--workdir <directory>', 'workdir whose runtime state should be checked')
    .action(async (options: { workdir?: string }) => {
      const workdir = options.workdir?.trim()
        ? resolveWorkdirOption(options.workdir)
        : undefined;
      const runSetup = handlers.runSetup ?? (await import('./commands/setup')).runSetupGuide;
      await runSetup({ workdir });
    });

  program
    .command('login')
    .description('Sign in and write local agent configuration')
    .action(async () => {
      const runLogin = handlers.runLogin ?? (await import('./commands/login')).runLogin;
      await runLogin();
    });

  program
    .command('actor')
    .description('Choose the pet actor used by this local agent')
    .action(async () => {
      const runActorSelect = handlers.runActorSelect ?? (await import('./actorSelection')).runActorSelect;
      await runActorSelect();
    });

  program
    .command('run')
    .description('Start the local agent service')
    .option('--workdir <directory>', 'agent working directory for runtime state and relative tool paths')
    .option('--stdio', 'use one-peer JSONL stdio instead of the local HTTP/WebSocket server')
    .action(async (options: { workdir?: string; stdio?: boolean }) => {
      const runAgent = handlers.runAgent ?? (await import('./commands/run')).runAgent;
      await runAgent({
        workdir: options.workdir?.trim() ? resolveWorkdirOption(options.workdir) : undefined,
        stdio: options.stdio ?? false,
      });
    });

  program
    .command('tui')
    .description('Start the interactive terminal UI')
    .option('--dry-run', 'run without writing generated post changes')
    .option('--workdir <directory>', 'agent working directory for runtime state and relative tool paths')
    .action(async (options: { dryRun?: boolean; workdir?: string }) => {
      const runTui = handlers.runTui ?? (await import('./commands/tui')).runTui;
      await runTui({
        dryRun: options.dryRun ?? false,
        workdir: options.workdir?.trim() ? resolveWorkdirOption(options.workdir) : undefined,
      });
    });

  program
    .command('detect')
    .description('Print local browser/backend detection as JSON')
    .action(async () => {
      const runDetect = handlers.runDetect ?? (await import('./commands/detect')).runDetect;
      await runDetect();
    });

  const browserCommand = program
    .command('browser')
    .description('Manage browser integrations');

  browserCommand
    .command('extension <action>')
    .description('Register, inspect or unregister the Chrome extension driver')
    .option('--extension-id <id>', 'Chrome extension ID shown by chrome://extensions')
    .action(async (action: string, options: { extensionId?: string }) => {
      const runBrowser = handlers.runBrowser
        ?? (await import('./commands/browser')).runBrowserCommand;
      await runBrowser('extension', action, options);
    });

  registerCapabilityCommand(program);

  return program;
}

export async function runLocalAgentCli(argv = process.argv): Promise<void> {
  const program = createLocalAgentCli();
  const effectiveArgv = argv.length <= 2 ? [...argv, 'run'] : argv;

  try {
    await program.parseAsync(effectiveArgv);
  } catch (error) {
    process.stderr.write(`${readErrorMessage(error)}\n`);
    process.exitCode = readExitCode(error);
  }
}
