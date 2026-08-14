import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  type AgentToolkit,
  validateToolkitDefinition,
} from '@pinpawo/pet-agent';
import { resolveToolkitAvailability } from './toolkits/toolkitAvailability';

export type LocalAgentPlugin = {
  name: string;
};

const PLUGINS_DIR = resolve(homedir(), '.pinpawo', 'plugins');

export type LoadedLocalPlugins = {
  toolkitDefinitions: AgentToolkit[];
  toolkits: AgentToolkit[];
  plugins: LocalAgentPlugin[];
};

function emptyLocalPlugins(): LoadedLocalPlugins {
  return {
    toolkitDefinitions: [],
    toolkits: [],
    plugins: [],
  };
}

export async function loadPlugins(options: { resolveAvailability?: boolean } = {}): Promise<LoadedLocalPlugins> {
  return loadPluginsFromDir(PLUGINS_DIR, options);
}

export async function loadPluginsFromDir(
  pluginsDir: string,
  options: { resolveAvailability?: boolean } = {},
): Promise<LoadedLocalPlugins> {
  if (!existsSync(pluginsDir)) return emptyLocalPlugins();

  const files = readdirSync(pluginsDir).filter((file) => file.endsWith('.mjs') || file.endsWith('.js'));
  if (files.length === 0) return emptyLocalPlugins();

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
      const ignoredTools = toolCount > 0 ? `, ignored ${toolCount} unsupported tools export${toolCount !== 1 ? 's' : ''}` : '';
      console.log(`[plugins] loaded "${(plugin as LocalAgentPlugin).name}" (${toolkitCount} toolkit${toolkitCount !== 1 ? 's' : ''}${ignoredTools})`);
    } catch (err) {
      console.warn(`[plugins] failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  toolkits.forEach(validateToolkitDefinition);
  if (options.resolveAvailability === false) {
    return {
      toolkitDefinitions: toolkits,
      toolkits: [...toolkits],
      plugins,
    };
  }
  const availabilityRecords = await Promise.all(
    toolkits.map((toolkit) => resolveToolkitAvailability(toolkit)),
  );
  for (const { toolkit, availability } of availabilityRecords) {
    if (!availability.available) {
      console.warn(
        `[plugins] Toolkit "${toolkit.name}" unavailable: ${availability.reason}`,
      );
    }
  }

  return {
    toolkitDefinitions: toolkits,
    toolkits: availabilityRecords
      .filter(({ availability }) => availability.available)
      .map(({ toolkit }) => toolkit),
    plugins,
  };
}
