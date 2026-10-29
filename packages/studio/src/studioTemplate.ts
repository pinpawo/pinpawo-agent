import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfigDocument } from '@pinpawo/pet-agent';
import { loadPetConfigs } from 'pinpawo/host-runtime';
import { studioLocalConfigSchema } from './configSchema';
import { resolveStudioStorage } from './host/buildStudio';
import { createStudioCredentialsKey } from './host/credentialsKey';
import { KyselyPetStore, type PetDatabase } from './pets/store/kysely';
import { studioCoreMigrations } from './storage/coreMigrations';
import { createStudioStorage } from './storage/studioStorage';

export type InitStudioWorkdirOptions = {
  workdir: string;
  /** Test seam; production uses the template shipped with @pinpawo/studio. */
  templateRoot?: string;
  /** Parent directory for durable Studio data; defaults to ~/.pinpawo/studios. */
  studioDataRoot?: string;
  /** Test seam for collision handling. Production generates a random UUID. */
  createStudioDataId?: () => string;
};

export type InitStudioWorkdirResult = {
  workdir: string;
  /** Paths under workdir are relative; Wiki files are absolute. */
  files: string[];
  wikiDirectory: string;
  /** The Pet credentials key, next to the Wiki in the Studio data directory. */
  credentialsKeyFile: string;
};

const DEFAULT_TEMPLATE_ROOT = fileURLToPath(
  new URL('../templates/default', import.meta.url),
);
const TEMPLATE_DESTINATIONS = [
  { source: 'studio.json', destination: '.pinpawo/studio.json' },
  { source: 'pets', destination: '.pinpawo/pets' },
  { source: 'wiki', destination: 'wiki' },
] as const;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Resolve even a not-yet-created path through its nearest existing ancestor. */
async function canonicalFuturePath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonicalFuturePath(parent), path.basename(file));
  }
}

function atOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Conservatively treat any .git entry at or above the path as a Git worktree boundary. */
async function hasGitMarkerAtOrAbove(directory: string): Promise<boolean> {
  let current = directory;
  for (;;) {
    try {
      await lstat(path.join(current, '.git'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function listFiles(root: string, relative: string): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

type TemplateFile = { source: string; destination: string };

async function listTemplateFiles(templateRoot: string): Promise<TemplateFile[]> {
  const files: TemplateFile[] = [];
  for (const root of TEMPLATE_DESTINATIONS) {
    const absolute = path.join(templateRoot, root.source);
    const entries = await readdir(path.dirname(absolute), { withFileTypes: true });
    const entry = entries.find(({ name }) => name === path.basename(absolute));
    if (!entry) throw new Error(`Studio workdir template is missing ${root.source}.`);
    if (entry.isDirectory()) {
      const children = await listFiles(templateRoot, root.source);
      files.push(...children.map((source) => ({
        source,
        destination: path.join(root.destination, path.relative(root.source, source)),
      })));
    } else if (entry.isFile()) {
      files.push({ source: root.source, destination: root.destination });
    } else {
      throw new Error(`Studio workdir template entry is not a file or directory: ${root.source}.`);
    }
  }
  return files;
}

function withStudioData(content: string, wikiDirectory: string, keyFile: string): string {
  const config: unknown = JSON.parse(content);
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Studio template config must be an object.');
  }
  const record = config as Record<string, unknown>;
  if (record.credentials !== undefined) throw new Error('Studio init cannot replace a template credentials setting.');
  record.credentials = { keyFile };
  if (record.plugins === undefined) return `${JSON.stringify(record, null, 2)}\n`;
  if (!Array.isArray(record.plugins)) throw new Error('Studio template plugins must be an array.');
  for (const entry of record.plugins) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const plugin = entry as Record<string, unknown>;
    if (plugin.id !== '@pinpawo-plugin/project-files') continue;
    const options = plugin.options ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Project Files template options must be an object.');
    }
    const existing = options as Record<string, unknown>;
    if ('directory' in existing || 'wikiDirectory' in existing) {
      throw new Error('Studio init cannot replace a Project Files template directory.');
    }
    plugin.options = { ...existing, wikiDirectory };
  }
  return `${JSON.stringify(record, null, 2)}\n`;
}

type CreatedFile = { path: string; dev: number; ino: number; content: Buffer };

/**
 * Give a new workdir one Pet per template definition, each under its
 * definition's id and name, so the template's own references (a trigger's
 * target, say) resolve on first start. Records the database files it is
 * about to create in `createdFiles`, so a failed init can remove them.
 */
async function createTemplatePets(
  workdir: string,
  configPath: string,
  configText: string,
  createdFiles: string[],
): Promise<void> {
  // A custom template may name no definitions; then there is no Pet to create.
  if (!Array.isArray((JSON.parse(configText) as { definitions?: unknown }).definitions)) return;
  const config = parseConfigDocument({ content: configText, source: configPath, schema: studioLocalConfigSchema });
  const storageConfig = resolveStudioStorage(config.storage, workdir);
  const databaseFiles = storageConfig.kind === 'sqlite'
    ? ['', '-wal', '-shm'].map(suffix => `${storageConfig.path}${suffix}`)
    : [];
  const existing = await Promise.all(databaseFiles.map(exists));
  if (existing.some(Boolean)) throw new Error(`Studio init refuses to reuse the existing database ${databaseFiles[0]}.`);
  createdFiles.push(...databaseFiles);
  const definitions = new Map((await loadPetConfigs(path.join(path.dirname(configPath), 'pets')))
    .map(definition => [definition.definitionId, definition]));
  const storage = createStudioStorage(storageConfig);
  try {
    const store = new KyselyPetStore(await storage.open<PetDatabase>('studio', studioCoreMigrations));
    const createdAt = new Date().toISOString();
    for (const definitionId of config.definitions) {
      const definition = definitions.get(definitionId);
      if (!definition) throw new Error(`Studio template definition "${definitionId}" has no file.`);
      await store.createPet({ petId: definitionId, definitionId, name: definition.name, createdAt });
    }
  } finally {
    await storage.close();
  }
}

/** Initialize a project configuration and a separate, durable Studio data directory (Wiki and credentials key). */
export async function initStudioWorkdir(
  options: InitStudioWorkdirOptions,
): Promise<InitStudioWorkdirResult> {
  const workdir = path.resolve(options.workdir);
  const templateRoot = options.templateRoot ?? DEFAULT_TEMPLATE_ROOT;
  const dataRoot = path.resolve(options.studioDataRoot ?? path.join(homedir(), '.pinpawo', 'studios'));
  const workdirReal = await canonicalFuturePath(workdir);
  const dataRootReal = await canonicalFuturePath(dataRoot);
  if (atOrInside(workdirReal, dataRootReal)) {
    // HOME may be selected as a general-purpose workdir; its default .pinpawo
    // data directory is separate from project code unless HOME is in a Git tree.
    const defaultHomeData = options.studioDataRoot === undefined
      && workdirReal === await canonicalFuturePath(homedir())
      && !await hasGitMarkerAtOrAbove(workdirReal);
    if (!defaultHomeData) {
      throw new Error('Studio data directory must be outside the project workdir. Choose another parent with --studio-data-root.');
    }
  }
  const instanceId = (options.createStudioDataId ?? randomUUID)();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) {
    throw new Error('Studio data id must be a version 4 UUID.');
  }
  const instanceDirectory = path.join(dataRoot, instanceId);
  const wikiDirectory = path.join(instanceDirectory, 'wiki');
  const credentialsKeyFile = path.join(instanceDirectory, 'credentials.key');
  const files = await listTemplateFiles(templateRoot);
  const localFiles = files.filter(({ source }) => source !== 'wiki' && !source.startsWith(`wiki${path.sep}`));
  const wikiFiles = files.filter(({ source }) => source.startsWith(`wiki${path.sep}`));
  const configSource = await readFile(path.join(templateRoot, 'studio.json'), 'utf8');
  const config = withStudioData(configSource, wikiDirectory, credentialsKeyFile);
  const conflicts = await Promise.all(localFiles.map(async ({ destination }) => (
    await exists(path.join(workdir, destination)) ? destination : null
  )));
  const conflict = conflicts.find((value): value is string => value !== null);
  if (conflict) throw new Error(`Studio init refuses to overwrite ${path.join(workdir, conflict)}.`);

  const created: CreatedFile[] = [];
  const databaseFiles: string[] = [];
  const knowledgeDirs = new Set<string>();
  const remember = async (file: string) => {
    const info = await lstat(file);
    created.push({ path: file, dev: info.dev, ino: info.ino, content: await readFile(file) });
  };
  try {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    // Exclusive instance creation prevents two initializations from sharing data.
    await mkdir(instanceDirectory, { mode: 0o700 });
    knowledgeDirs.add(instanceDirectory);
    await createStudioCredentialsKey(credentialsKeyFile);
    await remember(credentialsKeyFile);
    for (const file of wikiFiles) {
      const destination = path.join(wikiDirectory, path.relative('wiki', file.source));
      for (let dir = path.dirname(destination); atOrInside(instanceDirectory, dir); dir = path.dirname(dir)) {
        knowledgeDirs.add(dir);
        if (dir === instanceDirectory) break;
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(path.join(templateRoot, file.source), destination, constants.COPYFILE_EXCL);
      await remember(destination);
    }
    for (const file of localFiles) {
      const destination = path.join(workdir, file.destination);
      await mkdir(path.dirname(destination), { recursive: true });
      if (file.source === 'studio.json') await writeFile(destination, config, { flag: 'wx', mode: 0o600 });
      else await copyFile(path.join(templateRoot, file.source), destination, constants.COPYFILE_EXCL);
      await remember(destination);
    }
    await createTemplatePets(workdir, path.join(workdir, '.pinpawo/studio.json'), config, databaseFiles);
  } catch (error) {
    // The database is new (createTemplatePets refuses an existing one).
    for (const file of databaseFiles) await unlink(file).catch(() => undefined);
    // Only remove files created here that have not been replaced or modified.
    for (const file of created.reverse()) {
      try {
        const info = await lstat(file.path);
        if (info.isFile() && info.dev === file.dev && info.ino === file.ino
          && (await readFile(file.path)).equals(file.content)) await unlink(file.path);
      } catch { /* Preserve concurrent edits and the original error. */ }
    }
    for (const dir of [...knowledgeDirs].sort((a, b) => b.length - a.length)) {
      try { await rmdir(dir); } catch { /* Never remove nonempty directories. */ }
    }
    throw error;
  }
  return {
    workdir,
    files: [
      ...localFiles.map(({ destination }) => destination),
      ...wikiFiles.map(({ source }) => path.join(wikiDirectory, path.relative('wiki', source))),
    ],
    wikiDirectory,
    credentialsKeyFile,
  };
}
