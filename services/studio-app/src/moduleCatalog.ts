import type {
  ResolvedStudioModule,
  StudioModuleResolver,
} from '@pinpawo/studio';
import {
  createKanbanPlugin,
  loadStudioPlanningCapability,
} from '@pinpawo-toolkit/studio-kanban';

export type StudioModuleFactoryContext = {
  workdir: string;
};

export type StudioModuleFactory = (
  options: Record<string, unknown> | undefined,
  context: StudioModuleFactoryContext,
) => Promise<ResolvedStudioModule> | ResolvedStudioModule;

export type StudioModuleRegistration = {
  id: string;
  create: StudioModuleFactory;
};

export type CreateStudioModuleResolverOptions = StudioModuleFactoryContext & {
  registrations?: readonly StudioModuleRegistration[];
};

function createKanbanModule(options: Record<string, unknown> | undefined): ResolvedStudioModule {
  const optionNames = Object.keys(options ?? {});
  if (optionNames.length > 0) {
    throw new Error(
      `Studio module "kanban" does not support options: ${optionNames.join(', ')}`,
    );
  }
  const capability = loadStudioPlanningCapability();
  if (!capability) {
    throw new Error('Studio module "kanban" could not load its studio_planning Capability.');
  }
  return {
    plugin: createKanbanPlugin(),
    capabilities: [capability],
  };
}

export const INSTALLED_STUDIO_MODULES: readonly StudioModuleRegistration[] = [
  {
    id: 'kanban',
    create: createKanbanModule,
  },
];

/** Build the standalone application-owned resolver for explicitly installed modules. */
export function createStudioModuleResolver(
  options: CreateStudioModuleResolverOptions,
): StudioModuleResolver {
  const registrations = options.registrations ?? INSTALLED_STUDIO_MODULES;
  const factories = new Map<string, StudioModuleFactory>();
  for (const registration of registrations) {
    const id = registration.id.trim();
    if (!id) {
      throw new Error('Studio module registration id must not be empty.');
    }
    if (id !== registration.id) {
      throw new Error(`Studio module registration id must be trimmed: "${registration.id}".`);
    }
    if (factories.has(id)) {
      throw new Error(`Duplicate Studio module registration "${id}".`);
    }
    factories.set(id, registration.create);
  }

  return async (id, moduleOptions) => {
    const factory = factories.get(id);
    if (!factory) {
      const installed = [...factories.keys()].sort().join(', ') || '(none)';
      throw new Error(
        `Studio module "${id}" is not installed. Installed modules: ${installed}.`,
      );
    }
    return factory(moduleOptions, { workdir: options.workdir });
  };
}
