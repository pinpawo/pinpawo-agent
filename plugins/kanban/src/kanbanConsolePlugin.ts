import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type {
  StudioCliPluginEnvironment,
  StudioPlugin,
  StudioPluginContext,
} from '@pinpawo/studio';
import type { StudioHttpStaticAsset, StudioHttpStaticHook } from '@pinpawo-plugin/studio-http';

type KanbanConsoleAsset = StudioHttpStaticAsset;

export type CreateKanbanConsolePluginOptions = {
  httpPlugin?: string;
  mountPath?: string;
};

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function readOptions(options: CreateKanbanConsolePluginOptions): Required<CreateKanbanConsolePluginOptions> {
  const httpPlugin = options.httpPlugin?.trim() || 'http';
  const mountPath = options.mountPath?.trim() || '/';
  if (!httpPlugin) throw new Error('Kanban Console Plugin httpPlugin must not be empty.');
  if (!mountPath.startsWith('/')) throw new Error('Kanban Console Plugin mountPath must be absolute.');
  return { httpPlugin, mountPath };
}

function consoleAssetRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, 'console'),
    path.join(moduleDirectory, '..', 'console', 'dist'),
  ];
  const root = candidates.find((candidate) => existsSync(candidate));
  if (!root) {
    throw new Error('Kanban Console assets are missing. Build @pinpawo/kanban-console before starting Studio.');
  }
  return root;
}

function contentTypeFor(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

async function readConsoleAssets(root: string): Promise<Map<string, KanbanConsoleAsset>> {
  const assets = new Map<string, KanbanConsoleAsset>();
  const visit = async (directory: string, relativeDirectory = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const body = new Uint8Array(await readFile(absolutePath));
      assets.set(relativePath, {
        body,
        contentType: contentTypeFor(relativePath),
        cacheControl: relativePath.startsWith('assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-store',
      });
    }
  };
  await visit(root);
  if (!assets.has('index.html')) throw new Error('Kanban Console bundle is missing index.html.');
  return assets;
}

/** A zero-Toolkit UI Plugin; it only contributes its packaged static bundle. */
export function createKanbanConsolePlugin(
  input: CreateKanbanConsolePluginOptions = {},
): StudioPlugin {
  const options = readOptions(input);
  let unsubscribeStatic: (() => void) | undefined;

  return {
    name: 'kanban-console',
    toolkits: [],
    start: async (context: StudioPluginContext) => {
      const assets = await readConsoleAssets(consoleAssetRoot());
      unsubscribeStatic = context.hooks.contribute<StudioHttpStaticHook>(
        options.httpPlugin,
        'static',
        (staticFiles) => staticFiles.register({
          mountPath: options.mountPath,
          resolve: (relativePath) => assets.get(relativePath),
          fallback: 'index.html',
        }),
      );
    },
    stop: () => {
      unsubscribeStatic?.();
      unsubscribeStatic = undefined;
    },
  };
}

/** Explicit module identity consumed by the standalone Studio CLI loader. */
export const id = 'kanban-console';

export function createStudioPlugin(
  options: Record<string, unknown> | undefined,
  _environment: StudioCliPluginEnvironment,
): StudioPlugin {
  const unsupported = Object.keys(options ?? {}).filter(
    (key) => key !== 'httpPlugin' && key !== 'mountPath',
  );
  if (unsupported.length > 0) {
    throw new Error(`Kanban Console Plugin does not support CLI option(s): ${unsupported.join(', ')}.`);
  }
  const httpPlugin = options?.httpPlugin;
  const mountPath = options?.mountPath;
  if (httpPlugin !== undefined && typeof httpPlugin !== 'string') {
    throw new Error('Kanban Console Plugin option "httpPlugin" must be a string when present.');
  }
  if (mountPath !== undefined && typeof mountPath !== 'string') {
    throw new Error('Kanban Console Plugin option "mountPath" must be a string when present.');
  }
  return createKanbanConsolePlugin({ httpPlugin, mountPath });
}
