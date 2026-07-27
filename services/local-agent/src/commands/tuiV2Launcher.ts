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
};

export type RunTuiV2Options = {
  workdir?: string;
};

export function resolveTuiV2LaunchPlan(
  options: ResolveTuiV2LaunchPlanOptions,
): TuiV2LaunchPlan {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pathExists = options.pathExists ?? existsSync;
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
  const tuiRoot = join(workspaceRoot, 'services', 'tui');
  const workspaceSource = join(tuiRoot, 'src', 'main.ts');
  const configuredBun = env.PINPAWO_BUN_BIN?.trim();
  const workspaceBun = platform === 'win32'
    ? join(workspaceRoot, 'node_modules', '.bin', 'bun.cmd')
    : join(workspaceRoot, 'node_modules', '.bin', 'bun');
  if (
    pathExists(workspaceSource)
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
  const workspaceBinary = workspaceBinaryCandidates.find(pathExists);
  if (workspaceBinary) {
    return {
      source: 'workspace-binary',
      command: workspaceBinary,
      args: [],
    };
  }

  if (pathExists(workspaceSource)) {
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
      const missingBun = plan.source === 'workspace-source'
        && (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(new Error(missingBun
        ? [
            'Bun is required to run the OpenTUI workspace source.',
            'Build `@pinpawo/tui`, set PINPAWO_BUN_BIN,',
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
