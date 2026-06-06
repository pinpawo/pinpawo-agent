import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentToolkit, DailyPostPayload } from '@pinpawo/pet-agent';

export type LocalAgentPluginHooks = {
  beforeCrawl?: () => Promise<void>;
  afterPostSaved?: (postId: string, payload: DailyPostPayload) => Promise<void>;
};

export type LocalAgentPlugin = {
  name: string;
  hooks?: LocalAgentPluginHooks;
};

const PLUGINS_DIR = resolve(homedir(), '.pinpawo', 'plugins');

export async function loadPlugins(): Promise<{ tools: StructuredTool[]; toolkits: AgentToolkit[]; plugins: LocalAgentPlugin[] }> {
  return loadPluginsFromDir(PLUGINS_DIR);
}

export async function loadPluginsFromDir(pluginsDir: string): Promise<{ tools: StructuredTool[]; toolkits: AgentToolkit[]; plugins: LocalAgentPlugin[] }> {
  if (!existsSync(pluginsDir)) return { tools: [], toolkits: [], plugins: [] };

  const files = readdirSync(pluginsDir).filter((file) => file.endsWith('.mjs') || file.endsWith('.js'));
  if (files.length === 0) return { tools: [], toolkits: [], plugins: [] };

  const tools: StructuredTool[] = [];
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

      if (Array.isArray(mod.tools)) {
        tools.push(...(mod.tools as StructuredTool[]));
      }
      if (Array.isArray(mod.toolkits)) {
        toolkits.push(...(mod.toolkits as AgentToolkit[]));
      }

      plugins.push(plugin as LocalAgentPlugin);
      const toolCount = Array.isArray(mod.tools) ? mod.tools.length : 0;
      const toolkitCount = Array.isArray(mod.toolkits) ? mod.toolkits.length : 0;
      console.log(`[plugins] loaded "${(plugin as LocalAgentPlugin).name}" (${toolCount} tool${toolCount !== 1 ? 's' : ''}, ${toolkitCount} toolkit${toolkitCount !== 1 ? 's' : ''})`);
    } catch (err) {
      console.warn(`[plugins] failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  return { tools, toolkits, plugins };
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
