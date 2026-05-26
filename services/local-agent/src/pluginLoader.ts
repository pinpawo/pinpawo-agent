import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { StructuredTool } from '@langchain/core/tools';
import type { DailyPostPayload } from '@pinpawo/pet-agent';

export type LocalAgentPluginHooks = {
  beforeCrawl?: () => Promise<void>;
  afterPostSaved?: (postId: string, payload: DailyPostPayload) => Promise<void>;
};

export type LocalAgentPlugin = {
  name: string;
  hooks?: LocalAgentPluginHooks;
};

const PLUGINS_DIR = resolve(homedir(), '.pinpawo', 'plugins');

export async function loadPlugins(): Promise<{ tools: StructuredTool[]; plugins: LocalAgentPlugin[] }> {
  if (!existsSync(PLUGINS_DIR)) return { tools: [], plugins: [] };

  const files = readdirSync(PLUGINS_DIR).filter((file) => file.endsWith('.mjs') || file.endsWith('.js'));
  if (files.length === 0) return { tools: [], plugins: [] };

  const tools: StructuredTool[] = [];
  const plugins: LocalAgentPlugin[] = [];

  for (const file of files) {
    const filePath = resolve(PLUGINS_DIR, file);
    try {
      const mod = await import(filePath) as { default?: unknown; tools?: unknown };

      if (Array.isArray(mod.tools)) {
        tools.push(...(mod.tools as StructuredTool[]));
      }

      const plugin = mod.default;
      if (!plugin || typeof plugin !== 'object' || !('name' in plugin)) {
        console.warn(`[plugins] ${file}: must export a default object with { name } — skipped`);
        continue;
      }

      plugins.push(plugin as LocalAgentPlugin);
      const toolCount = Array.isArray(mod.tools) ? mod.tools.length : 0;
      console.log(`[plugins] loaded "${(plugin as LocalAgentPlugin).name}" (${toolCount} tool${toolCount !== 1 ? 's' : ''})`);
    } catch (err) {
      console.warn(`[plugins] failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  return { tools, plugins };
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
