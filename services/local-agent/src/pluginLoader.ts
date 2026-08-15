import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  type AgentToolkit,
  validateToolkitDefinition,
} from '@pinpawo/pet-agent';
import type { ToolkitDefinitionSource } from './toolkits/toolkitInventory';

export type LocalAgentPlugin = {
  name: string;
};

const PLUGINS_DIR = resolve(homedir(), '.pinpawo', 'plugins');

export type LoadedLocalPlugins = {
  toolkitSources: ToolkitDefinitionSource[];
  plugins: LocalAgentPlugin[];
};

function emptyLocalPlugins(): LoadedLocalPlugins {
  return {
    toolkitSources: [],
    plugins: [],
  };
}

export async function loadPlugins(): Promise<LoadedLocalPlugins> {
  return loadPluginsFromDir(PLUGINS_DIR);
}

export async function loadPluginsFromDir(
  pluginsDir: string,
): Promise<LoadedLocalPlugins> {
  if (!existsSync(pluginsDir)) return emptyLocalPlugins();

  const files = readdirSync(pluginsDir)
    .filter((file) => file.endsWith('.mjs') || file.endsWith('.js'))
    .sort();
  if (files.length === 0) return emptyLocalPlugins();

  const toolkitSources: ToolkitDefinitionSource[] = [];
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

      const loadedPlugin = plugin as LocalAgentPlugin;
      const definitions = Array.isArray(mod.toolkits)
        ? mod.toolkits as AgentToolkit[]
        : [];
      if (definitions.length > 0) {
        toolkitSources.push(Object.freeze({
          // The Host source identity describes where definitions came from,
          // not the plugin's user-facing display name. The file name is
          // deterministic, unique within the plugin directory, and actionable
          // when inventory validation reports a collision.
          id: file,
          kind: 'plugin',
          definitions: Object.freeze([...definitions]),
        }));
      }

      plugins.push(loadedPlugin);
      const toolCount = Array.isArray(mod.tools) ? mod.tools.length : 0;
      const toolkitCount = Array.isArray(mod.toolkits) ? mod.toolkits.length : 0;
      const ignoredTools = toolCount > 0 ? `, ignored ${toolCount} unsupported tools export${toolCount !== 1 ? 's' : ''}` : '';
      console.log(`[plugins] loaded "${(plugin as LocalAgentPlugin).name}" (${toolkitCount} toolkit${toolkitCount !== 1 ? 's' : ''}${ignoredTools})`);
    } catch (err) {
      console.warn(`[plugins] failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  for (const source of toolkitSources) {
    source.definitions.forEach(validateToolkitDefinition);
  }

  return {
    toolkitSources,
    plugins,
  };
}
