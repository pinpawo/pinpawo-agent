import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { DEFAULT_CAPABILITIES_DIR, readUserCapabilityManifests, validateCapabilityPlugin } from '../capabilityLoader';

type CapabilityCommandOptions = {
  overwrite: boolean;
  link: boolean;
};

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

function readDependencyWarning(rootDir: string, linked: boolean): string | null {
  const packagePath = resolve(rootDir, 'package.json');
  if (!existsSync(packagePath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dependencyCount = Object.keys(pkg.dependencies ?? {}).length
      + Object.keys(pkg.optionalDependencies ?? {}).length;
    if (dependencyCount === 0) return null;
    return linked
      ? 'This capability has package dependencies; keep npm install/update in the source directory because the install is linked.'
      : 'This capability has package dependencies; run npm install in the installed capability directory if node_modules was not copied.';
  } catch {
    return null;
  }
}

async function validateCommand(rootDir: string): Promise<void> {
  const result = await validateCapabilityPlugin(rootDir);
  if (!result.ok) {
    throw new Error(`Capability plugin invalid: ${result.errors.join('; ')}`);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    id: result.meta?.id,
    name: result.meta?.name,
    rootDir: result.rootDir,
    manifestPath: result.manifestPath,
    indexPath: result.indexPath,
    warnings: result.warnings,
  }, null, 2) + '\n');
}

async function installCommand(sourceArg: string, options: CapabilityCommandOptions): Promise<void> {
  const sourceDir = resolve(expandHome(sourceArg));
  const validation = await validateCapabilityPlugin(sourceDir);
  if (!validation.ok || !validation.meta) {
    throw new Error(`Capability plugin invalid: ${validation.errors.join('; ')}`);
  }

  const targetDir = resolve(DEFAULT_CAPABILITIES_DIR, validation.meta.id);
  if (resolve(sourceDir) === targetDir) {
    process.stdout.write(JSON.stringify({
      status: 'already_installed',
      id: validation.meta.id,
      targetDir,
    }, null, 2) + '\n');
    return;
  }

  if (existsSync(targetDir)) {
    if (!options.overwrite) {
      throw new Error(
        `Capability "${validation.meta.id}" already exists at ${targetDir}. Re-run with --overwrite to replace it.`,
      );
    }
    rmSync(targetDir, { recursive: true, force: true });
  }

  mkdirSync(dirname(targetDir), { recursive: true });
  if (options.link) {
    symlinkSync(sourceDir, targetDir, 'dir');
  } else {
    cpSync(sourceDir, targetDir, {
      recursive: true,
      dereference: false,
      filter: (source) => basename(source) !== '.git',
    });
  }

  const installedValidation = await validateCapabilityPlugin(targetDir);
  if (!installedValidation.ok) {
    throw new Error(`Capability installed but validation failed: ${installedValidation.errors.join('; ')}`);
  }

  const warning = readDependencyWarning(targetDir, options.link);
  process.stdout.write(JSON.stringify({
    status: 'installed',
    id: validation.meta.id,
    sourceDir,
    targetDir,
    mode: options.link ? 'link' : 'copy',
    warning,
    nextStep: 'Restart the agent, or use the desktop settings refresh button to rescan capabilities in a running agent.',
  }, null, 2) + '\n');
}

function listCommand(): void {
  process.stdout.write(JSON.stringify({
    defaultDir: DEFAULT_CAPABILITIES_DIR,
    capabilities: readUserCapabilityManifests(),
  }, null, 2) + '\n');
}

export function registerCapabilityCommand(program: Command): void {
  const capability = program
    .command('capability')
    .description('Manage local user capability plugins');

  capability
    .command('list')
    .description('List installed user capabilities')
    .action(() => {
      listCommand();
    });

  capability
    .command('validate <directory>')
    .description('Validate a capability plugin directory')
    .action(async (rootDir: string) => {
      await validateCommand(rootDir);
    });

  capability
    .command('install <directory>')
    .description('Install a capability plugin into the local capabilities directory')
    .option('--overwrite', 'replace an existing installed capability with the same id')
    .option('--link', 'install a symlink instead of copying the source directory')
    .action(async (sourceDir: string, command: Command) => {
      const options = command.opts() as Partial<CapabilityCommandOptions>;
      await installCommand(sourceDir, {
        overwrite: options.overwrite ?? false,
        link: options.link ?? false,
      });
    });
}
