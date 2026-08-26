import type { StudioPluginResolver } from './host/buildStudio';
import type { StudioPlugin } from './studioContract';

export type InstalledStudioPluginEnvironment = {
  workdir: string;
};

type InstalledStudioPluginPackage = {
  createStudioPlugin?: (
    options: Record<string, unknown> | undefined,
    environment: InstalledStudioPluginEnvironment,
  ) => StudioPlugin | Promise<StudioPlugin>;
};

export type CreateInstalledStudioPluginResolverOptions = {
  workdir: string;
  /** Test/embedding seam; production uses the Node package loader. */
  importPlugin?: (packageName: string) => Promise<unknown>;
};

function requirePackageName(value: string): string {
  const packageName = value.trim();
  const segment = '[a-zA-Z0-9][a-zA-Z0-9._-]*';
  const packagePattern = new RegExp(`^(?:@${segment}/)?${segment}$`);
  if (!packagePattern.test(packageName)) {
    throw new Error(`Studio Plugin id must be an installed package name: "${value}".`);
  }
  return packageName;
}

function readPluginPackage(value: unknown, packageName: string): InstalledStudioPluginPackage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Studio Plugin package "${packageName}" has no package exports.`);
  }
  const loaded = value as InstalledStudioPluginPackage;
  if (typeof loaded.createStudioPlugin !== 'function') {
    throw new Error(
      `Studio Plugin package "${packageName}" must export createStudioPlugin().`,
    );
  }
  return loaded;
}

/** Resolve explicitly configured, already-installed Plugin packages for the standalone CLI. */
export function createInstalledStudioPluginResolver(
  options: CreateInstalledStudioPluginResolverOptions,
): StudioPluginResolver {
  const importPlugin = options.importPlugin ?? ((packageName: string) => import(packageName));
  const packages = new Map<string, Promise<InstalledStudioPluginPackage>>();
  return async (id, pluginOptions) => {
    const packageName = requirePackageName(id);
    let loaded = packages.get(packageName);
    if (!loaded) {
      loaded = importPlugin(packageName).then((value) => readPluginPackage(value, packageName));
      packages.set(packageName, loaded);
    }
    const pluginPackage = await loaded;
    return pluginPackage.createStudioPlugin!(pluginOptions, {
      workdir: options.workdir,
    });
  };
}
