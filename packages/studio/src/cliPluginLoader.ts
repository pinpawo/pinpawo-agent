import type { StudioPlugin } from './studioContract';
import type { StudioPluginResolver } from './host/buildStudio';

/** Environment deliberately supplied to an installed Plugin factory by the CLI. */
export type StudioCliPluginEnvironment = {
  workdir: string;
};

/**
 * Contract exported by a package that the standalone Studio CLI may load.
 *
 * This is a CLI composition contract, not a Studio core registry. The CLI
 * imports a configured package dynamically; Studio receives only the returned
 * ordinary `StudioPlugin` through its existing resolver port.
 */
export type StudioCliPluginModule = {
  id: string;
  createStudioPlugin: (
    options: Record<string, unknown> | undefined,
    environment: StudioCliPluginEnvironment,
  ) => StudioPlugin | Promise<StudioPlugin>;
};

export type CreateStudioCliPluginResolverInput = {
  workdir: string;
  /** Injectable solely for deterministic loader tests. */
  loadModule?: (specifier: string) => Promise<unknown>;
};

function isPackageSpecifier(value: string): boolean {
  if (!value || value.startsWith('.') || value.startsWith('/') || value.includes('\\') || value.includes(':')) {
    return false;
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !segment)) return false;
  return /^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/.test(value);
}

function readPluginModule(value: unknown, specifier: string): StudioCliPluginModule {
  if (!value || typeof value !== 'object') {
    throw new Error(`Studio CLI Plugin module "${specifier}" must export an object.`);
  }
  const candidate = value as Partial<StudioCliPluginModule>;
  if (typeof candidate.id !== 'string' || !candidate.id) {
    throw new Error(`Studio CLI Plugin module "${specifier}" must export a non-empty id.`);
  }
  if (typeof candidate.createStudioPlugin !== 'function') {
    throw new Error(`Studio CLI Plugin module "${specifier}" must export createStudioPlugin().`);
  }
  return candidate as StudioCliPluginModule;
}

/**
 * Build the resolver used only by `pinpawo-studio`.
 *
 * Module locators remain explicit config data: no catalog, filesystem probing,
 * or network installation is performed. The same module is cached, while its
 * factory runs once per configured Plugin instance.
 */
export function createStudioCliPluginResolver(
  input: CreateStudioCliPluginResolverInput,
): StudioPluginResolver {
  const environment = Object.freeze({ workdir: input.workdir });
  const modules = new Map<string, Promise<StudioCliPluginModule>>();
  const loadModule = input.loadModule ?? (async (specifier: string) => await import(specifier));

  return async (id, options, moduleSpecifier) => {
    if (!moduleSpecifier) {
      throw new Error(
        `Studio CLI Plugin "${id}" must declare a package "module" in studio.json.`,
      );
    }
    if (!isPackageSpecifier(moduleSpecifier)) {
      throw new Error(
        `Studio CLI Plugin "${id}" module must be a package specifier, not a filesystem path.`,
      );
    }
    let module = modules.get(moduleSpecifier);
    if (!module) {
      module = loadModule(moduleSpecifier).then((loaded) => readPluginModule(loaded, moduleSpecifier));
      modules.set(moduleSpecifier, module);
    }
    const factory = await module;
    if (factory.id !== id) {
      throw new Error(
        `Studio CLI Plugin module "${moduleSpecifier}" exports id "${factory.id}", not configured id "${id}".`,
      );
    }
    const plugin = await factory.createStudioPlugin(options, environment);
    if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
      throw new Error(`Studio CLI Plugin "${id}" factory must return a StudioPlugin object.`);
    }
    return plugin;
  };
}
