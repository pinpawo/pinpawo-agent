import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type InitStudioWorkdirOptions = {
  workdir: string;
  /** Test seam; production uses the template shipped with @pinpawo/studio. */
  templateRoot?: string;
};

export type InitStudioWorkdirResult = {
  workdir: string;
  files: string[];
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
  } catch {
    return false;
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

/** Initialize a selected project workdir from the shipped Studio template. */
export async function initStudioWorkdir(
  options: InitStudioWorkdirOptions,
): Promise<InitStudioWorkdirResult> {
  const workdir = path.resolve(options.workdir);
  const templateRoot = options.templateRoot ?? DEFAULT_TEMPLATE_ROOT;
  const files = await listTemplateFiles(templateRoot);
  const conflicts = await Promise.all(files.map(async ({ destination }) => (
    await exists(path.join(workdir, destination)) ? destination : null
  )));
  const conflict = conflicts.find((value): value is string => value !== null);
  if (conflict) {
    throw new Error(`Studio init refuses to overwrite ${path.join(workdir, conflict)}.`);
  }
  for (const file of files) {
    const destination = path.join(workdir, file.destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(templateRoot, file.source), destination, constants.COPYFILE_EXCL);
  }
  return { workdir, files: files.map(({ destination }) => destination) };
}

/** @deprecated Use initStudioWorkdir. */
export const initStudioKickstart = initStudioWorkdir;

/** @deprecated Use InitStudioWorkdirOptions. */
export type InitStudioKickstartOptions = InitStudioWorkdirOptions;

/** @deprecated Use InitStudioWorkdirResult. */
export type InitStudioKickstartResult = InitStudioWorkdirResult;
