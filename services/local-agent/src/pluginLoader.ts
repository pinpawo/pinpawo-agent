import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import type { DailyPostPayload } from './capabilities/dailyPost';

export type LocalAgentPluginHooks = {
  beforeCrawl?: () => Promise<void>;
  afterPostSaved?: (postId: string, payload: DailyPostPayload) => Promise<void>;
};

export type LocalAgentPlugin = {
  name: string;
  hooks?: LocalAgentPluginHooks;
};

const PLUGINS_DIR = resolve(homedir(), '.pinpawo', 'plugins');

export async function loadPlugins(): Promise<{ toolkits: AgentToolkit[]; plugins: LocalAgentPlugin[] }> {
  return loadPluginsFromDir(PLUGINS_DIR);
}

export async function loadPluginsFromDir(pluginsDir: string): Promise<{ toolkits: AgentToolkit[]; plugins: LocalAgentPlugin[] }> {
  if (!existsSync(pluginsDir)) return { toolkits: [], plugins: [] };

  const files = readdirSync(pluginsDir).filter((file) => file.endsWith('.mjs') || file.endsWith('.js'));
  if (files.length === 0) return { toolkits: [], plugins: [] };

  const toolkits: AgentToolkit[] = [];
  const plugins: LocalAgentPlugin[] = [];

  for (const file of files) {
    const filePath = resolve(pluginsDir, file);
    try {
      const mod = await import(filePath) as { default?: unknown; tools?: unknown; toolkits?: unknown };

      const plugin = mod.default;
      if (!plugin || typeof plugin !== 'object' || !('name' in plugin)) {
        console.warn(`[plugins] ${file}: must export a default object with { name } — skipped`);
        continue;
      }

      if (Array.isArray(mod.toolkits)) {
        toolkits.push(...(mod.toolkits as AgentToolkit[]));
      }

      plugins.push(plugin as LocalAgentPlugin);
      const toolCount = Array.isArray(mod.tools) ? mod.tools.length : 0;
      const toolkitCount = Array.isArray(mod.toolkits) ? mod.toolkits.length : 0;
      const ignoredTools = toolCount > 0 ? `, ignored ${toolCount} legacy direct tool${toolCount !== 1 ? 's' : ''}` : '';
      console.log(`[plugins] loaded "${(plugin as LocalAgentPlugin).name}" (${toolkitCount} toolkit${toolkitCount !== 1 ? 's' : ''}${ignoredTools})`);
    } catch (err) {
      console.warn(`[plugins] failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  return { toolkits, plugins };
}

export function collectPluginHooks(plugins: LocalAgentPlugin[]) {
  return {
    beforeCrawl: async () => {
      for (const plugin of plugins) {
        if (plugin.hooks?.beforeCrawl) await plugin.hooks.beforeCrawl();
      }
    },
    afterPostSaved: async (postId: string, payload: DailyPostPayload) => {
      for (const plugin of plugins) {
        if (plugin.hooks?.afterPostSaved) await plugin.hooks.afterPostSaved(postId, payload);
      }
    },
  };
}
