import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StudioDueRunStatus, StudioDueRunStoreTrace } from '@pinpawo/pet-agent';
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
import {
  getLocalServerWorkdir,
  type LocalServerCapabilityStatePatch,
  type LocalServerDeps,
} from './localServerTypes';
import { buildLocalHttpRuntimeProjection } from './localConfigProjection';

type LocalHttpHandlerOptions = {
  authToken: string;
  loadSnapshot: () => Promise<unknown>;
  listSessions: () => Promise<unknown[]>;
  resumeSession: (sessionId: string) => Promise<{
    session: unknown;
    snapshot: unknown;
  }>;
  updateCapabilities?: (patch: LocalServerCapabilityStatePatch) => LocalServerDeps;
};

export function handleLocalHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalServerDeps,
  options: LocalHttpHandlerOptions,
) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const applyCapabilityUpdate = (patch: LocalServerCapabilityStatePatch): LocalServerDeps => {
    if (options.updateCapabilities) return options.updateCapabilities(patch);
    return Object.isFrozen(deps) ? { ...deps, ...patch } : Object.assign(deps, patch);
  };

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
      refreshRuntimeCapability(deps, refreshCapabilityName).then((patch) => {
        if (patch) applyCapabilityUpdate(patch);
        writeHealth();
      }).catch(() => {
        applyCapabilityUpdate(removeRuntimeCapability(deps, refreshCapabilityName));
        writeHealth();
      });
      return true;
    }

    writeHealth();
    return true;
  }

  if (pathname === '/runtime') {
    writeJson(res, 200, buildLocalHttpRuntimeProjection(deps));
    return true;
  }

  if (pathname === '/studio_due_runs') {
    const scheduler = deps.studioDueRunScheduler;
    if (!scheduler) {
      writeJson(res, 404, { error: 'studio_due_runs unavailable' });
      return true;
    }

    const status = parseStudioDueRunStatus(url.searchParams.get('status'));
    const limit = parsePositiveInteger(url.searchParams.get('limit'));
    const includeMetrics = shouldIncludeStudioDueRunMetrics(url.searchParams);

    if (url.searchParams.get('limit') !== null && limit === undefined) {
      writeJson(res, 400, { error: 'invalid limit' });
      return true;
    }

    const respondWithTrace = (trace: StudioDueRunStoreTrace[]) => {
      const next = (status ? trace.filter((row) => row.status === status) : trace)
        .slice(0, limit ?? trace.length);
      const payload = {
        workdir: getLocalServerWorkdir(deps),
        studio_due_runs_path: deps.runtimeConfig?.studioDueRunsPath,
        studio_due_runs: next,
      };
      return payload;
    };

    if (includeMetrics) {
      Promise.all([scheduler.trace(), scheduler.metrics()])
        .then(([trace, metrics]) => {
          writeJson(res, 200, {
            ...respondWithTrace(trace),
            studio_due_run_metrics: metrics,
          });
        })
        .catch((err) => {
          writeJson(res, 500, {
            error: err instanceof Error ? err.message : 'studio_due_runs trace failed',
          });
        });
      return true;
    }

    scheduler.trace()
      .then((trace) => {
        writeJson(res, 200, respondWithTrace(trace));
      })
      .catch((err) => {
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
    rescanUserCapabilities(deps).then(({ patch, summary }) => {
      const updatedDeps = applyCapabilityUpdate(patch);
      writeJson(res, 200, {
        status: 'ok',
        ...summary,
        ...buildCapabilitiesPayload(updatedDeps),
      });
    }).catch((err) => {
      writeJson(res, 500, {
        status: 'error',
        error: err instanceof Error ? err.message : 'capability rescan failed',
      });
    });
    return true;
  }

  if (pathname === '/snapshot') {
    options.loadSnapshot().then((snapshot) => {
      writeJson(res, 200, snapshot);
    }).catch((err) => {
      writeJson(res, 500, {
        error: err instanceof Error ? err.message : 'snapshot load failed',
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

function shouldIncludeStudioDueRunMetrics(searchParams: URLSearchParams): boolean {
  const include = searchParams.get('include')?.toLowerCase()?.trim();
  if (include === 'metrics' || include === 'all') {
    return true;
  }

  const metrics = searchParams.get('metrics');
  return metrics === '1' || metrics === 'true';
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

function replaceListItem<T>(
  items: T[] | undefined,
  matches: (item: T) => boolean,
  replacement: T | null,
): T[] | undefined {
  if (!items) return undefined;
  const index = items.findIndex(matches);
  if (!replacement) {
    return index >= 0 ? items.filter((_, itemIndex) => itemIndex !== index) : [...items];
  }
  if (index < 0) return [...items, replacement];
  return items.map((item, itemIndex) => itemIndex === index ? replacement : item);
}

function replaceLocalCapability(
  deps: LocalServerDeps,
  name: string,
  record: CapabilityAvailabilityRecord | null,
): LocalServerCapabilityStatePatch {
  const localCapabilities = replaceListItem(
    deps.localCapabilities,
    (item) => item.name === name,
    record?.availability.available ? record.capability : null,
  );
  return localCapabilities ? { localCapabilities } : {};
}

function replaceLocalToolkit(
  deps: LocalServerDeps,
  name: string,
  record: ToolkitAvailabilityRecord | null,
): LocalServerCapabilityStatePatch {
  const localToolkits = replaceListItem(
    deps.localToolkits,
    (item) => item.name === name,
    record?.availability.available ? record.toolkit : null,
  );
  return localToolkits ? { localToolkits } : {};
}

function replaceUserCapability(
  deps: LocalServerDeps,
  name: string,
  record: CapabilityAvailabilityRecord | null,
): LocalServerCapabilityStatePatch {
  const definition = record?.availability.available
    ? deps.userCapabilityDefinitions?.find((item) =>
      item.meta.id === name || item.capability.name === name,
    ) ?? null
    : null;
  const userCapabilities = replaceListItem(
    deps.userCapabilities,
    (item) => item.meta.id === name || item.capability.name === name,
    definition,
  );
  return userCapabilities ? { userCapabilities } : {};
}

function removeRuntimeCapability(
  deps: LocalServerDeps,
  name: string,
): LocalServerCapabilityStatePatch {
  return {
    ...replaceLocalCapability(deps, name, null),
    ...replaceLocalToolkit(deps, name, null),
    ...replaceUserCapability(deps, name, null),
  };
}

async function refreshRuntimeCapability(
  deps: LocalServerDeps,
  name: string,
): Promise<LocalServerCapabilityStatePatch | null> {
  const localRecord = await refreshCapability(deps.localCapabilityDefinitions ?? [], name);
  const localToolkitRecord = await refreshToolkit(deps.localToolkitDefinitions ?? [], name);
  if (localRecord || localToolkitRecord) {
    return {
      ...(localRecord ? replaceLocalCapability(deps, name, localRecord) : {}),
      ...(localToolkitRecord ? replaceLocalToolkit(deps, name, localToolkitRecord) : {}),
    };
  }

  const userDefinition = deps.userCapabilityDefinitions?.find((item) =>
    item.meta.id === name || item.capability.name === name,
  );
  if (!userDefinition) return null;

  const userRecord = await refreshCapability(
    deps.userCapabilityDefinitions?.map((item) => item.capability) ?? [],
    userDefinition.capability.name,
  );
  return replaceUserCapability(deps, name, userRecord);
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
  return {
    patch: {
      userCapabilityDefinitions: definitions,
      userCapabilities: available,
    } satisfies LocalServerCapabilityStatePatch,
    summary: {
      loaded: definitions.length,
      available: available.length,
    },
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
