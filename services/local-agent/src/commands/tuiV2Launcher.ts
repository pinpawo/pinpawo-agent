import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export type TuiV2LaunchSource =
  | 'override'
  | 'packaged-binary'
  | 'packaged-bundle'
  | 'workspace-binary'
  | 'workspace-source';

export type TuiV2LaunchPlan = {
  source: TuiV2LaunchSource;
  command: string;
  args: string[];
};

export type ResolveTuiV2LaunchPlanOptions = {
  localAgentRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  pathExists?: (path: string) => boolean;
  readTextFile?: (path: string) => string;
};

export type RunTuiV2Options = {
  workdir?: string;
};

export type TuiV2DistributionManifest = {
  schemaVersion: 1;
  format: 'bun-bundle';
  entry: 'main.js';
  tuiVersion: string;
  bunVersion: string;
  openTuiVersion: string;
  bytes: number;
  sha256: string;
};

export function parseTuiV2DistributionManifest(
  value: string,
): TuiV2DistributionManifest | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 1
      || parsed.format !== 'bun-bundle'
      || parsed.entry !== 'main.js'
      || !isExactVersion(parsed.tuiVersion)
      || !isExactVersion(parsed.bunVersion)
      || !isExactVersion(parsed.openTuiVersion)
      || !Number.isSafeInteger(parsed.bytes)
      || (parsed.bytes as number) <= 0
      || typeof parsed.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(parsed.sha256)
    ) {
      return null;
    }
    return parsed as TuiV2DistributionManifest;
  } catch {
    return null;
  }
}

export function resolveTuiV2LaunchPlan(
  options: ResolveTuiV2LaunchPlanOptions,
): TuiV2LaunchPlan {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pathExists = options.pathExists ?? existsSync;
  const readTextFile = options.readTextFile
    ?? ((path: string) => readFileSync(path, 'utf8'));
  const override = env.PINPAWO_TUI_V2_BIN?.trim();
  if (override) {
    return {
      source: 'override',
      command: override,
      args: [],
    };
  }

  const executableName = platform === 'win32'
    ? 'pinpawo-tui.exe'
    : 'pinpawo-tui';
  const platformExecutableName = platform === 'win32'
    ? `pinpawo-tui-${platform}-${arch}.exe`
    : `pinpawo-tui-${platform}-${arch}`;
  const packagedCandidates = [
    join(options.localAgentRoot, 'dist', 'tui', platformExecutableName),
    join(options.localAgentRoot, 'dist', 'tui', executableName),
  ];
  const packagedBinary = packagedCandidates.find(pathExists);
  if (packagedBinary) {
    return {
      source: 'packaged-binary',
      command: packagedBinary,
      args: [],
    };
  }

  const workspaceRoot = resolve(options.localAgentRoot, '..', '..');
  const isWorkspaceCheckout = hasTuiWorkspace(
    workspaceRoot,
    pathExists,
    readTextFile,
  );
  const tuiRoot = join(workspaceRoot, 'services', 'tui');
  const workspaceSource = join(tuiRoot, 'src', 'main.ts');
  const configuredBun = env.PINPAWO_BUN_BIN?.trim();
  const workspaceBun = platform === 'win32'
    ? join(workspaceRoot, 'node_modules', '.bin', 'bun.cmd')
    : join(workspaceRoot, 'node_modules', '.bin', 'bun');
  if (
    isWorkspaceCheckout
    && pathExists(workspaceSource)
    && (configuredBun || pathExists(workspaceBun))
  ) {
    return {
      source: 'workspace-source',
      command: configuredBun || workspaceBun,
      args: ['run', workspaceSource],
    };
  }

  const workspaceBinaryCandidates = [
    join(tuiRoot, 'dist', platformExecutableName),
    join(tuiRoot, 'dist', executableName),
  ];
  const workspaceBinary = isWorkspaceCheckout
    ? workspaceBinaryCandidates.find(pathExists)
    : undefined;
  if (workspaceBinary) {
    return {
      source: 'workspace-binary',
      command: workspaceBinary,
      args: [],
    };
  }

  const distributionRoot = join(options.localAgentRoot, 'dist', 'tui');
  const distributionManifestPath = join(distributionRoot, 'manifest.json');
  if (pathExists(distributionManifestPath)) {
    const manifest = parseTuiV2DistributionManifest(
      readTextFile(distributionManifestPath),
    );
    if (!manifest) {
      throw new Error(
        `OpenTUI v2 distribution manifest is invalid: ${distributionManifestPath}`,
      );
    }
    const entryPath = join(distributionRoot, manifest.entry);
    if (!pathExists(entryPath)) {
      throw new Error(
        `OpenTUI v2 distribution entry is missing: ${entryPath}`,
      );
    }
    const bunExecutableName = platform === 'win32' ? 'bun.cmd' : 'bun';
    const packageParent = resolve(options.localAgentRoot, '..');
    const bunCandidates = [
      join(options.localAgentRoot, 'node_modules', '.bin', bunExecutableName),
      join(packageParent, '.bin', bunExecutableName),
      workspaceBun,
    ];
    return {
      source: 'packaged-bundle',
      command: configuredBun
        || bunCandidates.find(pathExists)
        || 'bun',
      args: ['run', entryPath],
    };
  }

  if (isWorkspaceCheckout && pathExists(workspaceSource)) {
    return {
      source: 'workspace-source',
      command: 'bun',
      args: ['run', workspaceSource],
    };
  }

  throw new Error([
    'OpenTUI v2 is not bundled with this PinPawo installation.',
    'Use `pinpawo tui --legacy`, or provide PINPAWO_TUI_V2_BIN.',
  ].join(' '));
}

function isExactVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function hasTuiWorkspace(
  workspaceRoot: string,
  pathExists: (path: string) => boolean,
  readTextFile: (path: string) => string,
) {
  const packagePath = join(workspaceRoot, 'package.json');
  if (!pathExists(packagePath)) return false;
  try {
    const parsed = JSON.parse(readTextFile(packagePath)) as {
      workspaces?: unknown;
    };
    let workspaces = parsed.workspaces;
    if (
      workspaces
      && !Array.isArray(workspaces)
      && typeof workspaces === 'object'
    ) {
      workspaces = (workspaces as { packages?: unknown }).packages;
    }
    if (!Array.isArray(workspaces)) return false;
    return workspaces.includes('services/local-agent')
      && workspaces.includes('services/tui');
  } catch {
    return false;
  }
}

export async function runTuiV2(
  options: RunTuiV2Options = {},
): Promise<void> {
  if (options.workdir) {
    let isDirectory = false;
    try {
      isDirectory = statSync(options.workdir).isDirectory();
    } catch {
      // Report one stable launcher error below.
    }
    if (!isDirectory) {
      throw new Error(`TUI workdir is not a directory: ${options.workdir}`);
    }
  }
  const localAgentRoot = findLocalAgentPackageRoot(
    fileURLToPath(import.meta.url),
  );
  const plan = resolveTuiV2LaunchPlan({ localAgentRoot });
  await spawnTuiV2(plan, options);
}

export function findLocalAgentPackageRoot(
  modulePath: string,
  pathExists: (path: string) => boolean = existsSync,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): string {
  let current = dirname(modulePath);
  for (let depth = 0; depth < 5; depth += 1) {
    const packagePath = join(current, 'package.json');
    if (pathExists(packagePath)) {
      try {
        const parsed = JSON.parse(readFile(packagePath)) as { name?: unknown };
        if (parsed.name === 'pinpawo') return current;
      } catch {
        // Keep walking so a malformed unrelated package does not mask the
        // actual local-agent package root.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Could not locate the PinPawo local-agent package root.');
}

async function spawnTuiV2(
  plan: TuiV2LaunchPlan,
  options: RunTuiV2Options,
) {
  const cwd = options.workdir ?? process.cwd();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', (error) => {
      const missingBun = (
        plan.source === 'workspace-source'
        || plan.source === 'packaged-bundle'
      )
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new Error(missingBun
        ? [
            'Bun is required to run OpenTUI v2.',
            'Install optional dependencies, set PINPAWO_BUN_BIN,',
            'or use `pinpawo tui --legacy`.',
          ].join(' ')
        : `Could not start OpenTUI v2: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const exitCode = code ?? signalExitCode(signal);
      reject(Object.assign(
        new Error(
          signal
            ? `OpenTUI v2 exited after ${signal}`
            : `OpenTUI v2 exited with code ${exitCode}`,
        ),
        { exitCode },
      ));
    });
  });
}

function signalExitCode(signal: NodeJS.Signals | null) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}
