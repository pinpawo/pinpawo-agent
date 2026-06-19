import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import type { StudioDueRunStatus } from '@pinpawo/pet-agent';
import { BUILT_IN_CAPABILITY_REGISTRY } from './capabilityRegistry';
import {
  getCachedCapabilityAvailability,
  refreshCapability,
  refreshToolkit,
  resolveCapabilityAvailability,
  type CapabilityAvailabilityRecord,
  type ToolkitAvailabilityRecord,
} from './capabilities/capabilityAvailability';
import { loadUserCapabilities, readUserCapabilityManifests } from './capabilityLoader';
import type { LoadedUserCapability } from './capabilityLoader';
import { loadStoredConfig } from './storage';
import { readAgentActivityHealthFields } from './operationActivityState';
import { isAuthorizedLocalServerRequest } from './localServerAuth';
import type { LocalServerDeps } from './localServerTypes';
import { DEFAULT_STUDIO_CONFIG_PATH } from './studio/studioConfig';

type LocalHttpHandlerOptions = {
  authToken: string;
  loadHistory: () => Promise<Array<{ role: string; text: string }>>;
  listSessions: () => Promise<Array<Record<string, unknown>>>;
  resumeSession: (sessionId: string) => Promise<{
    session: Record<string, unknown>;
    messages: Array<{ role: string; text: string }>;
  }>;
};

export function handleLocalHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalServerDeps,
  options: LocalHttpHandlerOptions,
) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (!isAuthorizedLocalServerRequest(req, options.authToken)) {
    writeJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (pathname === '/health') {
    const writeHealth = () => {
      writeJson(res, 200, {
        status: 'ok',
        actor_id: deps.actorId,
        actor_name: deps.actorName,
        ...readBrowserHealthFields(),
        ...readAgentActivityHealthFields(),
      });
    };

    const refreshCapabilityName = url.searchParams.get('refresh_capability')
      ?? (url.searchParams.get('refresh_browser') === '1' ? 'browser' : null);
    if (refreshCapabilityName) {
      refreshRuntimeCapability(deps, refreshCapabilityName).then(() => {
        writeHealth();
      }).catch(() => {
        replaceLocalCapability(deps, refreshCapabilityName, null);
        replaceUserCapability(deps, refreshCapabilityName, null);
        writeHealth();
      });
      return true;
    }

    writeHealth();
    return true;
  }

  if (pathname === '/runtime') {
    const studioConfigFields = readStudioConfigRuntimeFields(deps);
    writeJson(res, 200, {
      llm_model: deps.llmConfig.model,
      llm_context_window_tokens: deps.llmConfig.contextWindowTokens,
      workdir: deps.workdir,
      ...(deps.runtimeConfig ? {
        state_root: deps.runtimeConfig.stateRoot,
        studio_config_path: deps.runtimeConfig.studioConfigPath,
        studio_due_runs_path: deps.runtimeConfig.studioDueRunsPath,
        pets_dir: deps.runtimeConfig.petsDir,
        studio_wiki_base_dir: deps.runtimeConfig.studioWikiBaseDir,
      } : {}),
      ...studioConfigFields,
    });
    return true;
  }

  if (pathname === '/studio_due_runs') {
    if (!deps.studioDueRunScheduler) {
      writeJson(res, 404, { error: 'studio_due_runs unavailable' });
      return true;
    }

    const status = parseStudioDueRunStatus(url.searchParams.get('status'));
    const limit = parsePositiveInteger(url.searchParams.get('limit'));

    if (url.searchParams.get('limit') !== null && limit === undefined) {
      writeJson(res, 400, { error: 'invalid limit' });
      return true;
    }

    deps.studioDueRunScheduler.trace().then((trace) => {
      const next = (status ? trace.filter((row) => row.status === status) : trace)
        .slice(0, limit ?? trace.length);
      writeJson(res, 200, {
        workdir: deps.runtimeConfig?.workdir ?? deps.workdir,
        studio_due_runs_path: deps.runtimeConfig?.studioDueRunsPath,
        studio_due_runs: next,
      });
    }).catch((err) => {
      writeJson(res, 500, {
        error: err instanceof Error ? err.message : 'studio_due_runs trace failed',
      });
    });
    return true;
  }

  if (pathname === '/capabilities') {
    writeJson(res, 200, buildCapabilitiesPayload(deps));
    return true;
  }

  if (pathname === '/capabilities/rescan') {
    rescanUserCapabilities(deps).then((summary) => {
      writeJson(res, 200, {
        status: 'ok',
        ...summary,
        ...buildCapabilitiesPayload(deps),
      });
    }).catch((err) => {
      writeJson(res, 500, {
        status: 'error',
        error: err instanceof Error ? err.message : 'capability rescan failed',
      });
    });
    return true;
  }

  if (pathname === '/history') {
    options.loadHistory().then((messages) => {
      writeJson(res, 200, { messages });
    }).catch((err) => {
      writeJson(res, 500, {
        error: err instanceof Error ? err.message : 'history load failed',
      });
    });
    return true;
  }

  if (pathname === '/sessions') {
    options.listSessions().then((sessions) => {
      writeJson(res, 200, { sessions });
    }).catch((err) => {
      writeJson(res, 500, {
        error: err instanceof Error ? err.message : 'sessions load failed',
      });
    });
    return true;
  }

  if (pathname === '/sessions/resume') {
    const sessionId = url.searchParams.get('sessionId')?.trim();
    if (!sessionId) {
      writeJson(res, 400, { error: 'sessionId is required' });
      return true;
    }
    options.resumeSession(sessionId).then((result) => {
      writeJson(res, 200, result);
    }).catch((err) => {
      writeJson(res, 404, {
        error: err instanceof Error ? err.message : 'session resume failed',
      });
    });
    return true;
  }

  return false;
}

function readStudioConfigRuntimeFields(deps: LocalServerDeps) {
  const preferredPath = deps.runtimeConfig?.studioConfigPath ?? DEFAULT_STUDIO_CONFIG_PATH;
  if (existsSync(preferredPath)) {
    return {
      studio_config_source: deps.runtimeConfig ? 'workdir' : 'legacy_home',
      studio_config_active_path: preferredPath,
      legacy_studio_config_path: DEFAULT_STUDIO_CONFIG_PATH,
    };
  }

  const legacyAvailable = preferredPath !== DEFAULT_STUDIO_CONFIG_PATH
    && existsSync(DEFAULT_STUDIO_CONFIG_PATH);
  return {
    studio_config_source: legacyAvailable ? 'legacy_home' : 'missing',
    studio_config_active_path: legacyAvailable ? DEFAULT_STUDIO_CONFIG_PATH : preferredPath,
    legacy_studio_config_path: DEFAULT_STUDIO_CONFIG_PATH,
  };
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function parseStudioDueRunStatus(value: string | null): StudioDueRunStatus | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'pending'
    || normalized === 'claimed'
    || normalized === 'running'
    || normalized === 'success'
    || normalized === 'failed'
    || normalized === 'canceled'
  ) {
    return normalized;
  }
  return null;
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function replaceLocalCapability(
  deps: LocalServerDeps,
  name: string,
  record: CapabilityAvailabilityRecord | null,
) {
  const localCapabilities = deps.localCapabilities;
  if (!localCapabilities) return;

  const index = localCapabilities.findIndex((item) => item.name === name);
  if (record?.availability.available) {
    if (index >= 0) {
      localCapabilities[index] = record.capability;
    } else {
      localCapabilities.push(record.capability);
    }
  } else if (index >= 0) {
    localCapabilities.splice(index, 1);
  }
}

function replaceLocalToolkit(
  deps: LocalServerDeps,
  name: string,
  record: ToolkitAvailabilityRecord | null,
) {
  const localToolkits = deps.localToolkits;
  if (!localToolkits) return;

  const index = localToolkits.findIndex((item) => item.name === name);
  if (record?.availability.available) {
    if (index >= 0) {
      localToolkits[index] = record.toolkit;
    } else {
      localToolkits.push(record.toolkit);
    }
  } else if (index >= 0) {
    localToolkits.splice(index, 1);
  }
}

function replaceUserCapability(
  deps: LocalServerDeps,
  name: string,
  record: CapabilityAvailabilityRecord | null,
) {
  const userCapabilities = deps.userCapabilities;
  if (!userCapabilities) return;

  const index = userCapabilities.findIndex((item) =>
    item.meta.id === name || item.capability.name === name,
  );
  if (record?.availability.available) {
    const definition = deps.userCapabilityDefinitions?.find((item) =>
      item.meta.id === name || item.capability.name === name,
    );
    if (!definition) return;
    if (index >= 0) {
      userCapabilities[index] = definition;
    } else {
      userCapabilities.push(definition);
    }
  } else if (index >= 0) {
    userCapabilities.splice(index, 1);
  }
}

async function refreshRuntimeCapability(deps: LocalServerDeps, name: string) {
  const localRecord = await refreshCapability(deps.localCapabilityDefinitions ?? [], name);
  const localToolkitRecord = await refreshToolkit(deps.localToolkitDefinitions ?? [], name);
  if (localRecord) {
    replaceLocalCapability(deps, name, localRecord);
  }
  if (localToolkitRecord) {
    replaceLocalToolkit(deps, name, localToolkitRecord);
  }
  if (localRecord || localToolkitRecord) {
    return;
  }

  const userDefinition = deps.userCapabilityDefinitions?.find((item) =>
    item.meta.id === name || item.capability.name === name,
  );
  if (!userDefinition) return;

  const userRecord = await refreshCapability(
    deps.userCapabilityDefinitions?.map((item) => item.capability) ?? [],
    userDefinition.capability.name,
  );
  replaceUserCapability(deps, name, userRecord);
}

function isCapabilityEnabled(id: string) {
  const caps = loadStoredConfig().capabilities;
  return !caps || !(id in caps) ? true : caps[id] === true;
}

async function filterAvailableUserCapabilities(
  loaded: LoadedUserCapability[],
  options: { force?: boolean } = {},
): Promise<LoadedUserCapability[]> {
  const records = await Promise.all(
    loaded.map(async (item) => ({
      item,
      availability: await resolveCapabilityAvailability(item.capability, options),
    })),
  );
  return records
    .filter((record) => record.availability.availability.available)
    .map((record) => record.item);
}

async function rescanUserCapabilities(deps: LocalServerDeps) {
  const runtimeRescan = deps.rescanUserCapabilities
    ? await deps.rescanUserCapabilities()
    : null;
  const definitions = runtimeRescan?.userCapabilityDefinitions ?? await loadUserCapabilities();
  const available = runtimeRescan?.userCapabilities
    ?? await filterAvailableUserCapabilities(definitions, { force: true });
  deps.userCapabilityDefinitions = definitions;
  deps.userCapabilities = available;
  return {
    loaded: definitions.length,
    available: available.length,
  };
}

function buildCapabilitiesPayload(deps: LocalServerDeps) {
  const localCapabilityIds = new Set((deps.localCapabilities ?? []).map((item) => item.name));
  const localDefinitionIds = new Set((deps.localCapabilityDefinitions ?? []).map((item) => item.name));
  const userDefinitions = deps.userCapabilityDefinitions ?? [];
  const userDefinitionIds = new Set(userDefinitions.flatMap((item) => [item.meta.id, item.capability.name]));
  const userAvailableIds = new Set(
    (deps.userCapabilities ?? []).flatMap((item) => [item.meta.id, item.capability.name]),
  );

  const builtIns = BUILT_IN_CAPABILITY_REGISTRY.map((meta) => {
    const availability = getCachedCapabilityAvailability(meta.id);
    const isHostRuntimeCapability = localDefinitionIds.has(meta.id);
    return {
      ...meta,
      enabled: isCapabilityEnabled(meta.id),
      loaded: true,
      available: isHostRuntimeCapability ? localCapabilityIds.has(meta.id) : isCapabilityEnabled(meta.id),
      availability: availability
        ? {
          available: availability.available,
          reason: availability.reason,
          detail: availability.detail,
          metadata: availability.metadata,
        }
        : null,
    };
  });

  const userManifests = readUserCapabilityManifests().map((meta) => {
    const definition = userDefinitions.find((item) => item.meta.id === meta.id);
    const availability = definition ? getCachedCapabilityAvailability(definition.capability.name) : null;
    return {
      ...meta,
      enabled: isCapabilityEnabled(meta.id),
      loaded: userDefinitionIds.has(meta.id),
      available: userAvailableIds.has(meta.id),
      availability: availability
        ? {
          available: availability.available,
          reason: availability.reason,
          detail: availability.detail,
          metadata: availability.metadata,
        }
        : null,
    };
  });

  return {
    builtIns,
    userCapabilities: userManifests,
  };
}

function readBrowserHealthFields() {
  const availability = getCachedCapabilityAvailability('browser');
  if (!availability) return {};

  const mode = availability.metadata?.mode;
  return {
    browser_mode: typeof mode === 'string'
      ? mode
      : availability.available
        ? 'available'
        : 'none',
    browser_detail: availability.detail ?? availability.reason,
  };
}
