import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerCapabilityCommand } from './commands/capability';

type LocalAgentCliHandlers = {
  runLogin?: () => Promise<void> | void;
  runActorSelect?: () => Promise<void> | void;
  runAgent?: () => Promise<void> | void;
  runTui?: (opts: { dryRun: boolean }) => Promise<void> | void;
  runDetect?: () => Promise<void> | void;
};

function readPackageVersion(): string {
  try {
    const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function readExitCode(error: unknown): number {
  const value = (error as { exitCode?: unknown } | null)?.exitCode;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

export function createLocalAgentCli(handlers: LocalAgentCliHandlers = {}): Command {
  const program = new Command();
  program
    .name('pinpawo-agent')
    .description('PinPawo local agent CLI')
    .version(readPackageVersion());

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
    .action(async () => {
      const runAgent = handlers.runAgent ?? (await import('./commands/run')).runAgent;
      await runAgent();
    });

  program
    .command('tui')
    .description('Start the interactive terminal UI')
    .option('--dry-run', 'run without writing generated post changes')
    .action(async (options: { dryRun?: boolean }) => {
      const runTui = handlers.runTui ?? (await import('./commands/tui')).runTui;
      await runTui({ dryRun: options.dryRun ?? false });
    });

  program
    .command('detect')
    .description('Print local browser/backend detection as JSON')
    .action(async () => {
      const runDetect = handlers.runDetect ?? (await import('./commands/detect')).runDetect;
      await runDetect();
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
