import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
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

function parseOptions(args: string[]): { positional: string[]; options: CapabilityCommandOptions } {
  const positional: string[] = [];
  const options: CapabilityCommandOptions = {
    overwrite: false,
    link: false,
  };

  for (const arg of args) {
    if (arg === '--overwrite') {
      options.overwrite = true;
    } else if (arg === '--link') {
      options.link = true;
    } else {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function usage(): string {
  return [
    'Usage:',
    '  pinpawo-agent capability list',
    '  pinpawo-agent capability validate <directory>',
    '  pinpawo-agent capability install <directory> [--overwrite] [--link]',
  ].join('\n');
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

async function validateCommand(rootDir: string): Promise<number> {
  const result = await validateCapabilityPlugin(rootDir);
  if (!result.ok) {
    process.stderr.write(`Capability plugin invalid: ${result.errors.join('; ')}\n`);
    return 1;
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
  return 0;
}

async function installCommand(sourceArg: string, options: CapabilityCommandOptions): Promise<number> {
  const sourceDir = resolve(expandHome(sourceArg));
  const validation = await validateCapabilityPlugin(sourceDir);
  if (!validation.ok || !validation.meta) {
    process.stderr.write(`Capability plugin invalid: ${validation.errors.join('; ')}\n`);
    return 1;
  }

  const targetDir = resolve(DEFAULT_CAPABILITIES_DIR, validation.meta.id);
  if (resolve(sourceDir) === targetDir) {
    process.stdout.write(JSON.stringify({
      status: 'already_installed',
      id: validation.meta.id,
      targetDir,
    }, null, 2) + '\n');
    return 0;
  }

  if (existsSync(targetDir)) {
    if (!options.overwrite) {
      process.stderr.write(
        `Capability "${validation.meta.id}" already exists at ${targetDir}. Re-run with --overwrite to replace it.\n`,
      );
      return 1;
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
    process.stderr.write(`Capability installed but validation failed: ${installedValidation.errors.join('; ')}\n`);
    return 1;
  }

  const warning = readDependencyWarning(targetDir, options.link);
  process.stdout.write(JSON.stringify({
    status: 'installed',
    id: validation.meta.id,
    sourceDir,
    targetDir,
    mode: options.link ? 'link' : 'copy',
    warning,
    nextStep: 'Restart the agent or call GET http://127.0.0.1:3210/capabilities/rescan to load it in a running agent.',
  }, null, 2) + '\n');
  return 0;
}

function listCommand(): number {
  process.stdout.write(JSON.stringify({
    defaultDir: DEFAULT_CAPABILITIES_DIR,
    capabilities: readUserCapabilityManifests(),
  }, null, 2) + '\n');
  return 0;
}

export async function runCapabilityCommand(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'list';
  const { positional, options } = parseOptions(args.slice(1));
  let exitCode = 0;

  if (subcommand === 'list') {
    exitCode = listCommand();
  } else if (subcommand === 'validate') {
    const rootDir = positional[0];
    if (!rootDir) {
      process.stderr.write(`${usage()}\n`);
      exitCode = 1;
    } else {
      exitCode = await validateCommand(rootDir);
    }
  } else if (subcommand === 'install') {
    const sourceDir = positional[0];
    if (!sourceDir) {
      process.stderr.write(`${usage()}\n`);
      exitCode = 1;
    } else {
      exitCode = await installCommand(sourceDir, options);
    }
  } else {
    process.stderr.write(`Unknown capability command: ${subcommand}\n${usage()}\n`);
    exitCode = 1;
  }

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
