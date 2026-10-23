import {
  createInstalledStudioPluginResolver as createCorePluginResolver,
  runStudioHostCli as runCoreCli,
  runStudioHostProcess as runCoreProcess,
  type CreateInstalledStudioPluginResolverOptions,
  type StudioHostCliHandlers,
  type StudioHostProcessDependencies,
  type StudioHostProcessOptions,
} from '@pinpawo/studio-core';

export * from '@pinpawo/studio-core';

/** Resolve from the complete distribution, including its installed Plugins. */
export function createInstalledStudioPluginResolver(
  options: CreateInstalledStudioPluginResolverOptions,
) {
  return createCorePluginResolver({
    ...options,
    importPlugin: options.importPlugin ?? ((name: string) => import(name)),
  });
}

export function runStudioHostProcess(
  options: StudioHostProcessOptions,
  dependencies: StudioHostProcessDependencies = {},
) {
  return runCoreProcess(options, {
    ...dependencies,
    createPluginResolver: dependencies.createPluginResolver ?? createInstalledStudioPluginResolver,
  });
}

export function runStudioHostCli(
  argv = process.argv.slice(2),
  handlers: StudioHostCliHandlers = {},
) {
  return runCoreCli(argv, {
    ...handlers,
    runHost: handlers.runHost ?? runStudioHostProcess,
  });
}
