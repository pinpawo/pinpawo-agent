import type {
  StudioPluginHookInstaller,
  StudioPluginHooks,
} from './studioContract';

type HookProvider = {
  owner: string;
  name: string;
  value: unknown;
};

type HookContribution = {
  owner: string;
  targetPluginName: string;
  hookName: string;
  install: StudioPluginHookInstaller<unknown>;
  provider?: HookProvider;
  cleanup?: () => void;
};

function readName(value: string, label: string): string {
  if (!value.trim()) throw new Error(`Studio Plugin hook ${label} must not be empty.`);
  return value;
}

function hookKey(pluginName: string, hookName: string): string {
  return JSON.stringify([pluginName, hookName]);
}

function runCleanup(contribution: HookContribution): void {
  const cleanup = contribution.cleanup;
  contribution.provider = undefined;
  contribution.cleanup = undefined;
  if (!cleanup) return;
  try {
    cleanup();
  } catch (error) {
    console.error(
      `[studio] Plugin hook cleanup failed (owner=${contribution.owner}, `
      + `target=${contribution.targetPluginName}/${contribution.hookName}):`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** Lifecycle owner for opaque, order-independent Plugin hook contributions. */
export class StudioPluginHookRegistry {
  private readonly providers = new Map<string, HookProvider>();
  private readonly contributions = new Set<HookContribution>();

  private attach(contribution: HookContribution, provider: HookProvider): void {
    const cleanup = contribution.install(provider.value);
    if (cleanup !== undefined && typeof cleanup !== 'function') {
      throw new Error('Studio Plugin hook installer must return void or a cleanup function.');
    }
    contribution.provider = provider;
    contribution.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  }

  private removeProvider(provider: HookProvider): void {
    const key = hookKey(provider.owner, provider.name);
    if (this.providers.get(key) !== provider) return;
    for (const contribution of this.contributions) {
      if (contribution.provider === provider) runCleanup(contribution);
    }
    this.providers.delete(key);
  }

  private expose<T>(owner: string, rawName: string, value: T): () => void {
    const name = readName(rawName, 'name');
    const key = hookKey(owner, name);
    if (this.providers.has(key)) {
      throw new Error(`Studio Plugin "${owner}" exposed duplicate hook "${name}".`);
    }
    const provider: HookProvider = { owner, name, value };
    this.providers.set(key, provider);
    const attached: HookContribution[] = [];
    try {
      for (const contribution of this.contributions) {
        if (
          contribution.targetPluginName === owner
          && contribution.hookName === name
          && !contribution.provider
        ) {
          this.attach(contribution, provider);
          attached.push(contribution);
        }
      }
    } catch (error) {
      for (const contribution of attached.reverse()) runCleanup(contribution);
      this.providers.delete(key);
      throw error;
    }
    return () => this.removeProvider(provider);
  }

  private contribute<T>(
    owner: string,
    rawTargetPluginName: string,
    rawHookName: string,
    install: StudioPluginHookInstaller<T>,
  ): () => void {
    const targetPluginName = readName(rawTargetPluginName, 'target Plugin name');
    const hookName = readName(rawHookName, 'name');
    if (typeof install !== 'function') {
      throw new Error('Studio Plugin hook installer must be a function.');
    }
    const contribution: HookContribution = {
      owner,
      targetPluginName,
      hookName,
      install: install as StudioPluginHookInstaller<unknown>,
    };
    this.contributions.add(contribution);
    try {
      const provider = this.providers.get(hookKey(targetPluginName, hookName));
      if (provider) this.attach(contribution, provider);
    } catch (error) {
      this.contributions.delete(contribution);
      throw error;
    }
    return () => {
      if (!this.contributions.delete(contribution)) return;
      runCleanup(contribution);
    };
  }

  contextFor(ownerName: string): StudioPluginHooks {
    const owner = readName(ownerName, 'owner');
    return {
      expose: <T>(name: string, hook: T) => this.expose(owner, name, hook),
      contribute: <T>(
        targetPluginName: string,
        hookName: string,
        install: StudioPluginHookInstaller<T>,
      ) => this.contribute(owner, targetPluginName, hookName, install),
    };
  }

  releasePlugin(ownerName: string): void {
    for (const contribution of [...this.contributions]) {
      if (contribution.owner !== ownerName) continue;
      this.contributions.delete(contribution);
      runCleanup(contribution);
    }
    for (const provider of [...this.providers.values()]) {
      if (provider.owner === ownerName) this.removeProvider(provider);
    }
  }
}
