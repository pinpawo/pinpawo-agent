import path from 'node:path';
import type { StudioPlugin, StudioPluginContext } from '@pinpawo/studio-core';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { createProjectFilesToolkit } from './projectFilesToolkit';
import {
  ProjectFileTooLargeError,
  ProjectFilesService,
  type ProjectFilesServiceOptions,
} from './projectFilesService';

export type CreateProjectFilesPluginOptions = ProjectFilesServiceOptions & {
  rootDir: string;
  httpRoute?: false | { pluginName?: string };
};

/**
 * Project Files contributes a scoped Toolkit and, at start, HTTP routes. Its
 * lifecycle only needs hooks: it cannot reach dispatch, Pets, the event bus,
 * or dispatch queues.
 */
export type ProjectFilesPluginContext = Pick<StudioPluginContext, 'hooks'>;

export type ProjectFilesPlugin = StudioPlugin & {
  service: ProjectFilesService;
  start: (context: ProjectFilesPluginContext) => void;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createProjectFilesPlugin(
  options: CreateProjectFilesPluginOptions,
): ProjectFilesPlugin {
  const service = new ProjectFilesService(options.rootDir, options);
  let unregisterRoutes: (() => void) | undefined;
  let started = false;

  return {
    name: 'project-files',
    toolkits: [createProjectFilesToolkit(service)],
    service,
    start: (context) => {
      if (started) throw new Error('Project Files Plugin is already started.');
      started = true;
      const route = options.httpRoute;
      if (route === false) return;
      unregisterRoutes = context.hooks.contribute<StudioHttpRoutesHook>(
        route?.pluginName ?? 'http',
        'routes',
        (routes) => {
          const unregister: Array<() => void> = [];
          try {
            unregister.push(routes.register({
              method: 'GET',
              path: '/knowledge',
              handle: async () => ({
                kind: 'json',
                body: { documents: await service.listDocuments() },
              }),
            }));
            unregister.push(routes.register({
              method: 'GET',
              path: '/knowledge/document',
              handle: async ({ url }) => {
                try {
                  const documentPath = url.searchParams.get('path');
                  if (documentPath === null) throw new Error('Knowledge document path is required.');
                  const document = await service.readDocument(documentPath);
                  return document
                    ? { kind: 'json', body: { document } }
                    : { kind: 'json', status: 404, body: { error: 'Project document not found.' } };
                } catch (error) {
                  return {
                    kind: 'json',
                    status: error instanceof ProjectFileTooLargeError ? 413 : 400,
                    body: { error: asError(error).message },
                  };
                }
              },
            }));
          } catch (error) {
            for (const remove of unregister.reverse()) remove();
            throw error;
          }
          return () => { for (const remove of unregister.reverse()) remove(); };
        },
      );
    },
    stop: () => {
      unregisterRoutes?.();
      unregisterRoutes = undefined;
    },
  };
}

function readInstalledOptions(value: Record<string, unknown> | undefined): {
  directory: string;
  wikiDirectory?: string;
  maxDocuments?: number;
  maxFileBytes?: number;
  httpRoute?: false | { pluginName?: string };
} {
  const options = value ?? {};
  const allowed = new Set(['directory', 'wikiDirectory', 'maxDocuments', 'maxFileBytes', 'httpRoute']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Project Files Plugin option "${unknown}" is not supported.`);
  const wikiDirectory = options.wikiDirectory;
  if (wikiDirectory !== undefined && options.directory !== undefined) {
    throw new Error('Project Files Plugin directory and wikiDirectory cannot both be configured.');
  }
  if (wikiDirectory !== undefined && (
    typeof wikiDirectory !== 'string' || !wikiDirectory.trim()
    || wikiDirectory.includes('\0') || !path.isAbsolute(wikiDirectory.trim())
  )) {
    throw new Error('Project Files Plugin wikiDirectory must be an absolute path.');
  }
  const directory = options.directory ?? 'wiki';
  if (typeof directory !== 'string' || !directory.trim() || path.isAbsolute(directory)) {
    throw new Error('Project Files Plugin directory must be a relative path.');
  }
  const normalized = path.normalize(directory.trim());
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Project Files Plugin directory must stay inside the Studio workdir.');
  }
  for (const field of ['maxDocuments', 'maxFileBytes'] as const) {
    if (options[field] !== undefined && typeof options[field] !== 'number') {
      throw new Error(`Project Files Plugin option "${field}" must be a number.`);
    }
  }
  const httpRoute = options.httpRoute;
  if (httpRoute !== undefined && httpRoute !== false
    && (!httpRoute || typeof httpRoute !== 'object' || Array.isArray(httpRoute))) {
    throw new Error('Project Files Plugin httpRoute must be false or an object.');
  }
  const pluginName = httpRoute && 'pluginName' in httpRoute ? httpRoute.pluginName : undefined;
  if (pluginName !== undefined && typeof pluginName !== 'string') {
    throw new Error('Project Files Plugin httpRoute.pluginName must be a string.');
  }
  return {
    directory: normalized,
    ...(typeof wikiDirectory === 'string' ? { wikiDirectory: path.resolve(wikiDirectory.trim()) } : {}),
    ...(typeof options.maxDocuments === 'number' ? { maxDocuments: options.maxDocuments } : {}),
    ...(typeof options.maxFileBytes === 'number' ? { maxFileBytes: options.maxFileBytes } : {}),
    ...(httpRoute === false
      ? { httpRoute: false as const }
      : pluginName ? { httpRoute: { pluginName } } : {}),
  };
}

export function createStudioPlugin(
  value: Record<string, unknown> | undefined,
  environment: { workdir: string },
): ProjectFilesPlugin {
  const options = readInstalledOptions(value);
  // Only trusted installation configuration selects a knowledge root; HTTP
  // clients can request relative Markdown paths within that root, never roots.
  const rootDir = options.wikiDirectory ?? path.join(environment.workdir, options.directory);
  return createProjectFilesPlugin({
    rootDir,
    boundaryDir: options.wikiDirectory ?? environment.workdir,
    ...(options.maxDocuments === undefined ? {} : { maxDocuments: options.maxDocuments }),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.httpRoute === undefined ? {} : { httpRoute: options.httpRoute }),
  });
}
