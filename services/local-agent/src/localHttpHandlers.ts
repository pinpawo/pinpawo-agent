import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  type StudioDueRunStatus,
  type StudioDueRunStoreTrace,
} from '@pinpawo/pet-agent';
import { BUILT_IN_CAPABILITY_REGISTRY } from './capabilityRegistry';
import {
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
import {
  browserRuntime,
  getCachedBrowserAvailability,
} from './toolkits/browser';
import {
  prepareAgentRegistry,
  projectExecutorCompilationIssues,
} from './agentRegistryPreparation';

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

function replacePluginToolkit(
  deps: LocalServerDeps,
  name: string,
  record: ToolkitAvailabilityRecord | null,
): LocalServerCapabilityStatePatch {
  const pluginToolkits = replaceListItem(
    deps.pluginToolkits,
    (item) => item.name === name,
    record?.availability.available ? record.toolkit : null,
  );
  return pluginToolkits ? { pluginToolkits } : {};
}

function removeRuntimeToolkit(
  deps: LocalServerDeps,
  name: string,
): LocalServerCapabilityStatePatch {
  return {
    ...replaceLocalToolkit(deps, name, null),
    ...replacePluginToolkit(deps, name, null),
  };
}

async function refreshRuntimeToolkit(
  deps: LocalServerDeps,
  name: string,
): Promise<LocalServerCapabilityStatePatch | null> {
  const localToolkitRecord = await refreshToolkit(deps.localToolkitDefinitions ?? [], name);
  if (localToolkitRecord) {
    return replaceLocalToolkit(deps, name, localToolkitRecord);
  }
  const pluginToolkitRecord = await refreshToolkit(
    deps.pluginToolkitDefinitions ?? [],
    name,
  );
  return pluginToolkitRecord
    ? replacePluginToolkit(deps, name, pluginToolkitRecord)
    : null;
}

function isCapabilityEnabled(id: string) {
  const caps = loadStoredConfig().capabilities;
  return !caps || !(id in caps) ? true : caps[id] === true;
}

async function rescanUserCapabilities(deps: LocalServerDeps) {
  const userCapabilities = deps.rescanUserCapabilities
    ? await deps.rescanUserCapabilities()
    : await loadUserCapabilities();
  return {
    patch: {
      userCapabilities,
    } satisfies LocalServerCapabilityStatePatch,
    summary: {
      loaded: userCapabilities.length,
    },
  };
}

function buildCapabilitiesPayload(
  deps: LocalServerDeps,
  threadId?: string,
) {
  const localCapabilityIds = new Set((deps.localCapabilities ?? []).map((item) => item.name));
  const userCapabilities = deps.userCapabilities ?? [];
  const userCapabilityIds = new Set(
    userCapabilities.flatMap((item) => [item.meta.id, item.capability.name]),
  );
  const capabilities = [...(deps.localCapabilities ?? [])];
  for (const { capability } of userCapabilities) {
    if (!capabilities.some(({ name }) => name === capability.name)) {
      capabilities.push(capability);
    }
  }
  const prepared = prepareAgentRegistry({
    toolkits: [
      ...(deps.pluginToolkits ?? []),
      ...(deps.localToolkits ?? []),
    ],
    capabilities,
    threadId,
    capabilityArtifactStore: deps.capabilityArtifactStore,
  });
  const hasArtifactDiscoveryToolkit = prepared.toolkits.some(
    ({ name }) => name === ARTIFACT_DISCOVERY_TOOLKIT_NAME,
  );
  const missingArtifactDiscoveryScope = [
    ...(!threadId ? ['threadId' as const] : []),
    ...(!deps.capabilityArtifactStore ? ['capabilityArtifactStore' as const] : []),
  ];
  const capabilitiesByName = new Map(
    capabilities.map((capability) => [capability.name, capability]),
  );
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
    const capability = capabilitiesByName.get(capabilityName);
    if (
      !hasArtifactDiscoveryToolkit
      && missingArtifactDiscoveryScope.length > 0
      && capability?.uses.includes(ARTIFACT_DISCOVERY_TOOLKIT_NAME)
    ) {
      return {
        status: 'requires_scope' as const,
        required: missingArtifactDiscoveryScope,
      };
    }
    const unavailable = unavailableByName.get(capabilityName);
    if (unavailable) {
      return {
        status: 'unavailable' as const,
        issues: projectExecutorCompilationIssues(
          unavailable.issues,
          [
            ...(deps.pluginToolkitDefinitions ?? []),
            ...(deps.localToolkitDefinitions ?? []),
          ],
        ),
      };
    }
    return compiledNames.has(capabilityName)
      ? { status: 'available' as const }
      : null;
  };

  const builtIns = BUILT_IN_CAPABILITY_REGISTRY.map((meta) => {
    const capability = deps.localCapabilities?.find(({ name }) => name === meta.id);
    const isHostRuntimeCapability = localCapabilityIds.has(meta.id);
    return {
      ...meta,
      enabled: isCapabilityEnabled(meta.id),
      loaded: true,
      routability: isHostRuntimeCapability
        ? resolveRoutability(capability?.name ?? meta.id)
        : null,
    };
  });

  const userManifests = readUserCapabilityManifests().map((meta) => {
    const loadedCapability = userCapabilities.find((item) => item.meta.id === meta.id);
    return {
      ...meta,
      enabled: isCapabilityEnabled(meta.id),
      loaded: userCapabilityIds.has(meta.id),
      routability: loadedCapability
        ? resolveRoutability(loadedCapability.capability.name)
        : null,
    };
  });

  return {
    builtIns,
    userCapabilities: userManifests,
  };
}

function readBrowserHealthFields() {
  const availability = getCachedBrowserAvailability();
  if (!availability) return {};

  const mode = availability.metadata?.mode;
  const extension = browserRuntime.getSnapshot().extension;
  const cachedCommandReady = availability.metadata?.commandReady;
  const commandReady = mode === 'extension'
    ? extension.commandReady
    : typeof cachedCommandReady === 'boolean'
      ? cachedCommandReady
      : false;
  return {
    browser_mode: typeof mode === 'string'
      ? mode
      : availability.available
        ? 'available'
        : 'none',
    browser_detail: mode === 'extension'
      ? extension.detail
      : availability.detail ?? availability.reason,
    browser_runtime_state: extension.state,
    browser_extension_detail: extension.detail,
    browser_bridge_listening: extension.bridgeListening,
    browser_host_connected: extension.nativeHostConnected,
    browser_extension_connected: extension.extensionRegistered,
    browser_command_ready: commandReady,
    browser_extension_command_ready: extension.commandReady,
    browser_debugger_attached: extension.debuggerAttached,
    browser_target_alive: extension.targetAlive,
    browser_active_tab_binding: extension.activeTabBinding,
    browser_extension_id: extension.extensionId,
    browser_state_revision: extension.stateRevision,
  };
}
