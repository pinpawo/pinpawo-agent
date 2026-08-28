import path from 'node:path';
import type { StudioPlugin } from '@pinpawo/studio';
import type { StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import {
  ProjectFileTooLargeError,
  ProjectFilesService,
  type ProjectFilesServiceOptions,
} from './projectFilesService';

export type CreateProjectFilesPluginOptions = ProjectFilesServiceOptions & {
  rootDir: string;
  httpRoute?: false | { pluginName?: string };
};

export type ProjectFilesPlugin = StudioPlugin & {
  service: ProjectFilesService;
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
    toolkits: [],
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
  maxDocuments?: number;
  maxFileBytes?: number;
  httpRoute?: false | { pluginName?: string };
} {
  const options = value ?? {};
  const allowed = new Set(['directory', 'maxDocuments', 'maxFileBytes', 'httpRoute']);
  const unknown = Object.keys(options).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Project Files Plugin option "${unknown}" is not supported.`);
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
  return createProjectFilesPlugin({
    rootDir: path.join(environment.workdir, options.directory),
    boundaryDir: environment.workdir,
    ...(options.maxDocuments === undefined ? {} : { maxDocuments: options.maxDocuments }),
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
    ...(options.httpRoute === undefined ? {} : { httpRoute: options.httpRoute }),
  });
}
