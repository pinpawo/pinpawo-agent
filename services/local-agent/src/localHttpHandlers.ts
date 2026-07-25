import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  StudioDueRunStatus,
  StudioDueRunStoreTrace,
} from '@pinpawo/pet-agent';
import { BUILT_IN_CAPABILITY_REGISTRY } from './capabilityRegistry';
import {
  getCachedToolkitAvailability,
  refreshToolkit,
  type ToolkitAvailabilityRecord,
} from './toolkits/toolkitAvailability';
import { loadUserCapabilities, readUserCapabilityManifests } from './capabilityLoader';
import { loadStoredConfig } from './storage';
import { readAgentActivityHealthFields } from './operationActivityState';
import { isAuthorizedLocalServerRequest } from './localServerAuth';
import {
  getLocalServerWorkdir,
  type LocalServerCapabilityStatePatch,
  type LocalServerDeps,
} from './localServerTypes';
import { buildLocalHttpRuntimeProjection } from './localConfigProjection';
import { browserRuntime } from './toolkits/browser';
import { prepareAgentRegistry } from './agentRegistryPreparation';

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

    const refreshToolkitName = url.searchParams.get('refresh_toolkit');
    if (refreshToolkitName) {
      refreshRuntimeToolkit(deps, refreshToolkitName).then((patch) => {
        if (patch) applyCapabilityUpdate(patch);
        writeHealth();
      }).catch(() => {
        applyCapabilityUpdate(removeRuntimeToolkit(deps, refreshToolkitName));
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
    writeJson(
      res,
      200,
      buildCapabilitiesPayload(deps, url.searchParams.get('threadId')?.trim() || undefined),
    );
    return true;
  }

  if (pathname === '/capabilities/rescan') {
    rescanUserCapabilities(deps).then(({ patch, summary }) => {
      const updatedDeps = applyCapabilityUpdate(patch);
      writeJson(res, 200, {
        status: 'ok',
        ...summary,
        ...buildCapabilitiesPayload(
          updatedDeps,
          url.searchParams.get('threadId')?.trim() || undefined,
        ),
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
      const statusCode = err
        && typeof err === 'object'
        && 'code' in err
        && err.code === 'session_resume_conflict'
        ? 409
        : 404;
      writeJson(res, statusCode, {
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

function removeRuntimeToolkit(
  deps: LocalServerDeps,
  name: string,
): LocalServerCapabilityStatePatch {
  return replaceLocalToolkit(deps, name, null);
}

async function refreshRuntimeToolkit(
  deps: LocalServerDeps,
  name: string,
): Promise<LocalServerCapabilityStatePatch | null> {
  const localToolkitRecord = await refreshToolkit(deps.localToolkitDefinitions ?? [], name);
  return localToolkitRecord
    ? replaceLocalToolkit(deps, name, localToolkitRecord)
    : null;
}

function isCapabilityEnabled(id: string) {
  const caps = loadStoredConfig().capabilities;
  return !caps || !(id in caps) ? true : caps[id] === true;
}

async function rescanUserCapabilities(deps: LocalServerDeps) {
  const runtimeRescan = deps.rescanUserCapabilities
    ? await deps.rescanUserCapabilities()
    : null;
  const definitions = runtimeRescan?.userCapabilityDefinitions ?? await loadUserCapabilities();
  const available = runtimeRescan?.userCapabilities ?? definitions;
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

function buildCapabilitiesPayload(
  deps: LocalServerDeps,
  threadId?: string,
) {
  const localDefinitionIds = new Set((deps.localCapabilityDefinitions ?? []).map((item) => item.name));
  const userDefinitions = deps.userCapabilityDefinitions ?? [];
  const userDefinitionIds = new Set(userDefinitions.flatMap((item) => [item.meta.id, item.capability.name]));
  const capabilityDefinitions = [...(deps.localCapabilityDefinitions ?? [])];
  for (const { capability } of userDefinitions) {
    if (!capabilityDefinitions.some(({ name }) => name === capability.name)) {
      capabilityDefinitions.push(capability);
    }
  }
  const prepared = prepareAgentRegistry({
    toolkits: [
      ...(deps.pluginToolkits ?? []),
      ...(deps.localToolkits ?? []),
    ],
    capabilities: capabilityDefinitions,
    generalUses: [],
    threadId,
    capabilityArtifactStore: deps.capabilityArtifactStore,
  });
  const compiledNames = new Set(
    prepared.registry.capabilities.map(({ capability }) => capability.name),
  );
  const unavailableByName = new Map(
    prepared.registry.unavailableCapabilities.map((item) => [
      item.capability.name,
      item,
    ]),
  );
  const resolveRoutability = (
    capabilityName: string,
  ) => {
    const required = prepared.scopeRequirements.get(capabilityName);
    if (required) {
      return {
        status: 'requires_scope' as const,
        required,
      };
    }
    const unavailable = unavailableByName.get(capabilityName);
    if (unavailable) {
      return {
        status: 'unavailable' as const,
        issues: unavailable.issues,
      };
    }
    return compiledNames.has(capabilityName)
      ? { status: 'available' as const }
      : null;
  };

  const builtIns = BUILT_IN_CAPABILITY_REGISTRY.map((meta) => {
    const definition = deps.localCapabilityDefinitions?.find(({ name }) => name === meta.id);
    const isHostRuntimeCapability = localDefinitionIds.has(meta.id);
    return {
      ...meta,
      enabled: isCapabilityEnabled(meta.id),
      loaded: true,
      routability: isHostRuntimeCapability
        ? resolveRoutability(definition?.name ?? meta.id)
        : null,
    };
  });

  const userManifests = readUserCapabilityManifests().map((meta) => {
    const definition = userDefinitions.find((item) => item.meta.id === meta.id);
    return {
      ...meta,
      enabled: isCapabilityEnabled(meta.id),
      loaded: userDefinitionIds.has(meta.id),
      routability: definition
        ? resolveRoutability(definition.capability.name)
        : null,
    };
  });

  return {
    builtIns,
    userCapabilities: userManifests,
  };
}

function readBrowserHealthFields() {
  const availability = getCachedToolkitAvailability('browser');
  if (!availability) return {};

  return {
    browser_mode: availability.available ? 'available' : 'none',
    browser_detail: availability.available ? undefined : availability.reason,
    ...browserRuntime.getHealthFields(availability.available ? 'available' : 'none'),
  };
}
