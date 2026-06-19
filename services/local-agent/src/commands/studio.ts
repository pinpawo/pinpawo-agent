import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { buildLocalAgentRuntimeConfig, type LocalAgentRuntimeConfig } from '../runtimeConfig';
import { DEFAULT_PETS_DIR } from '../studio/petConfig';
import { DEFAULT_STUDIO_CONFIG_PATH } from '../studio/studioConfig';

const DEFAULT_STUDIO_WIKI_BASE_DIR = path.join(homedir(), '.pinpawo', 'studio-wiki');

export type StudioMigrateOptions = {
  workdir?: string;
  force?: boolean;
};

export type StudioMigratePlan = {
  runtimeConfig: LocalAgentRuntimeConfig;
  entries: StudioMigrateEntry[];
};

export type StudioMigrateEntry = {
  label: string;
  source: string;
  target: string;
  status: 'copied' | 'skipped-missing' | 'skipped-existing' | 'skipped-same-path';
};

type StudioMigrateDeps = {
  sources?: {
    studioConfigPath?: string;
    petsDir?: string;
    studioWikiBaseDir?: string;
  };
  runtimeConfig?: LocalAgentRuntimeConfig;
};

export async function migrateStudioConfig(
  options: StudioMigrateOptions = {},
  deps: StudioMigrateDeps = {},
): Promise<StudioMigratePlan> {
  const runtimeConfig = deps.runtimeConfig ?? buildLocalAgentRuntimeConfig(options.workdir);
  const sources = {
    studioConfigPath: deps.sources?.studioConfigPath ?? DEFAULT_STUDIO_CONFIG_PATH,
    petsDir: deps.sources?.petsDir ?? DEFAULT_PETS_DIR,
    studioWikiBaseDir: deps.sources?.studioWikiBaseDir ?? DEFAULT_STUDIO_WIKI_BASE_DIR,
  };

  const entries = await Promise.all([
    copyEntry('Studio config', sources.studioConfigPath, runtimeConfig.studioConfigPath, options.force ?? false),
    copyEntry('Pets config', sources.petsDir, runtimeConfig.petsDir, options.force ?? false),
    copyEntry('Studio wiki', sources.studioWikiBaseDir, runtimeConfig.studioWikiBaseDir, options.force ?? false),
  ]);

  return { runtimeConfig, entries };
}

export async function runStudioMigrate(options: StudioMigrateOptions = {}): Promise<void> {
  const plan = await migrateStudioConfig(options);
  process.stdout.write(formatStudioMigratePlan(plan));
}

export function formatStudioMigratePlan(plan: StudioMigratePlan): string {
  return `${[
    'PinPawo Studio migrate',
    '',
    `Workdir: ${plan.runtimeConfig.workdir}`,
    `Runtime state: ${plan.runtimeConfig.stateRoot}`,
    '',
    'Files:',
    ...plan.entries.map((entry) => `  ${formatStatus(entry.status)} ${entry.label}: ${entry.source} -> ${entry.target}`),
    '',
    'Legacy files are left in place.',
  ].join('\n')}\n`;
}

async function copyEntry(
  label: string,
  source: string,
  target: string,
  force: boolean,
): Promise<StudioMigrateEntry> {
  if (path.resolve(source) === path.resolve(target)) {
    return { label, source, target, status: 'skipped-same-path' };
  }

  if (!await exists(source)) {
    return { label, source, target, status: 'skipped-missing' };
  }

  if (!force && await exists(target)) {
    return { label, source, target, status: 'skipped-existing' };
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, {
    recursive: true,
    force,
    errorOnExist: !force,
  });

  return { label, source, target, status: 'copied' };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function formatStatus(status: StudioMigrateEntry['status']) {
  if (status === 'copied') return '[copied]';
  if (status === 'skipped-existing') return '[exists]';
  if (status === 'skipped-same-path') return '[same]';
  return '[missing]';
}
