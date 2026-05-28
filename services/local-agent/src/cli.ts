import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerCapabilityCommand } from './commands/capability';

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

export function createLocalAgentCli(): Command {
  const program = new Command();
  program
    .name('pinpawo-agent')
    .description('PinPawo local agent CLI')
    .version(readPackageVersion());

  program
    .command('login')
    .description('Sign in and write local agent configuration')
    .action(async () => {
      const { runLogin } = await import('./commands/login');
      await runLogin();
    });

  program
    .command('actor')
    .description('Choose the pet actor used by this local agent')
    .action(async () => {
      const { runActorSelect } = await import('./actorSelection');
      await runActorSelect();
    });

  program
    .command('run')
    .description('Start the local agent service')
    .action(async () => {
      const { runAgent } = await import('./commands/run');
      await runAgent();
    });

  program
    .command('once')
    .description('Run the deprecated one-shot daily post flow')
    .option('--dry-run', 'run without writing generated post changes')
    .option('--no-db', 'read crawler JSON output without DB ingest')
    .action(async (command: Command) => {
      const options = command.opts() as { dryRun?: boolean; noDb?: boolean };
      const { runOnce } = await import('./commands/once');
      await runOnce({
        dryRun: options.dryRun ?? false,
        noDb: options.noDb ?? false,
      });
    });

  program
    .command('tui')
    .description('Start the interactive terminal UI')
    .option('--dry-run', 'run without writing generated post changes')
    .action(async (command: Command) => {
      const options = command.opts() as { dryRun?: boolean };
      const { runTui } = await import('./commands/tui');
      await runTui({ dryRun: options.dryRun ?? false });
    });

  program
    .command('detect')
    .description('Print local browser/backend detection as JSON')
    .action(async () => {
      const { runDetect } = await import('./commands/detect');
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
