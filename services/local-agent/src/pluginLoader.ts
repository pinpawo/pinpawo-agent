import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  type AgentToolkit,
  validateToolkitDefinition,
} from '@pinpawo/pet-agent';
import type { ToolkitDefinitionSource } from './toolkits/toolkitInventory';
import type { ToolkitRuntimeRequirement } from './toolkits/runtimeBinding';
import type { RuntimeClientFactory } from './runtimeService/hostClient';

export type AgentPlugin = {
  name: string;
};

const PLUGINS_DIR = resolve(homedir(), '.pinpawo', 'plugins');

export type LoadedLocalPlugins = {
  toolkitSources: ToolkitDefinitionSource[];
  plugins: AgentPlugin[];
  runtimeClients: Readonly<Record<string, RuntimeClientFactory>>;
};

function emptyLocalPlugins(): LoadedLocalPlugins {
  return {
    toolkitSources: [],
    plugins: [],
    runtimeClients: {},
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
  const plugins: AgentPlugin[] = [];
  const runtimeClients: Record<string, RuntimeClientFactory> = Object.create(null);

  for (const file of files) {
    const filePath = resolve(pluginsDir, file);
    try {
      const mod = await import(pathToFileURL(filePath).href) as {
        default?: unknown;
        tools?: unknown;
        toolkitRegistrations?: unknown;
        toolkits?: unknown;
        toolkitRuntimeRequirements?: unknown;
        runtimeClients?: Record<string, unknown>;
      };

      const plugin = mod.default;
      if (!plugin || typeof plugin !== 'object' || !('name' in plugin)) {
        console.warn(`[plugins] ${file}: must export a default object with { name } — skipped`);
        continue;
      }

      const loadedPlugin = plugin as AgentPlugin;
      if (mod.toolkitRegistrations !== undefined) {
        throw new Error('Plugin export toolkitRegistrations was removed; use toolkitRuntimeRequirements.');
      }
      const candidateRuntimeClients = mod.runtimeClients ?? {};
      for (const [kind, factory] of Object.entries(candidateRuntimeClients)) {
        if (typeof factory !== 'function' || Object.hasOwn(runtimeClients, kind)) {
          throw new Error(`Invalid or duplicate Runtime client adapter: ${kind}`);
        }
      }
      if (Array.isArray(mod.toolkits) && Array.isArray(mod.toolkitRuntimeRequirements)) {
        throw new Error('Plugin must export either toolkits or toolkitRuntimeRequirements, not both.');
      }
      if (Array.isArray(mod.toolkits) && mod.toolkits.some((toolkit) => (
        toolkit != null
        && typeof toolkit === 'object'
        && (Object.hasOwn(toolkit, 'runtime') || Object.hasOwn(toolkit, 'runtimeKind'))
      ))) {
        throw new Error('Runtime metadata belongs in toolkitRuntimeRequirements, not AgentToolkit exports.');
      }
      const definitions = Array.isArray(mod.toolkitRuntimeRequirements)
        ? mod.toolkitRuntimeRequirements as ToolkitRuntimeRequirement[]
        : Array.isArray(mod.toolkits)
          ? (mod.toolkits as AgentToolkit[]).map((toolkit) => Object.freeze({ toolkit }))
          : [];
      // Publish only after the module shape and adapters have validated. A
      // skipped plugin must not leave a partial adapter or Toolkit source.
      Object.assign(runtimeClients, candidateRuntimeClients);
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
      const toolkitCount = definitions.length;
      const ignoredTools = toolCount > 0 ? `, ignored ${toolCount} unsupported tools export${toolCount !== 1 ? 's' : ''}` : '';
      console.log(`[plugins] loaded "${(plugin as AgentPlugin).name}" (${toolkitCount} toolkit${toolkitCount !== 1 ? 's' : ''}${ignoredTools})`);
    } catch (err) {
      console.warn(`[plugins] failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }

  for (const source of toolkitSources) {
    source.definitions.forEach(({ toolkit }) => validateToolkitDefinition(toolkit));
  }

  return {
    toolkitSources,
    plugins,
    runtimeClients: Object.freeze(runtimeClients),
  };
}
