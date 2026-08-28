import { constants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type InitStudioKickstartOptions = {
  workdir: string;
  /** Test seam; production uses the template shipped with @pinpawo/studio. */
  templateRoot?: string;
};

export type InitStudioKickstartResult = {
  workdir: string;
  files: string[];
};

const DEFAULT_TEMPLATE_ROOT = fileURLToPath(
  new URL('../examples/kanban-workdir', import.meta.url),
);
const TEMPLATE_ROOTS = ['.pinpawo/studio.json', '.pinpawo/pets', 'wiki'] as const;

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

async function listTemplateFiles(templateRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const relative of TEMPLATE_ROOTS) {
    const absolute = path.join(templateRoot, relative);
    const entries = await readdir(path.dirname(absolute), { withFileTypes: true });
    const entry = entries.find(({ name }) => name === path.basename(absolute));
    if (!entry) throw new Error(`Studio kickstart template is missing ${relative}.`);
    if (entry.isDirectory()) files.push(...await listFiles(templateRoot, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Studio kickstart template entry is not a file or directory: ${relative}.`);
  }
  return files;
}

/** Copy the shipped Studio kickstart config without overwriting project files. */
export async function initStudioKickstart(
  options: InitStudioKickstartOptions,
): Promise<InitStudioKickstartResult> {
  const workdir = path.resolve(options.workdir);
  const templateRoot = options.templateRoot ?? DEFAULT_TEMPLATE_ROOT;
  const files = await listTemplateFiles(templateRoot);
  const conflicts = await Promise.all(files.map(async (relative) => (
    await exists(path.join(workdir, relative)) ? relative : null
  )));
  const conflict = conflicts.find((value): value is string => value !== null);
  if (conflict) {
    throw new Error(`Studio kickstart init refuses to overwrite ${path.join(workdir, conflict)}.`);
  }
  for (const relative of files) {
    const destination = path.join(workdir, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(templateRoot, relative), destination, constants.COPYFILE_EXCL);
  }
  return { workdir, files };
}
