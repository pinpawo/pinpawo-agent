import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ARTIFACT_DISCOVERY_TOOLKIT_NAME,
} from '@pinpawo/pet-agent';
import { BUILT_IN_CAPABILITY_REGISTRY } from './capabilityRegistry';
import { loadUserCapabilities, readUserCapabilityManifests } from './capabilityLoader';
import { loadStoredConfig } from './storage';
import { readAgentActivityHealthFields } from './operationActivityState';
import { isAuthorizedLocalServerRequest } from './localServerAuth';
import {
  getLocalServerToolkitInventory,
  getLocalServerWorkdir,
  type LocalServerExtensionStatePatch,
  type LocalServerDeps,
} from './localServerTypes';
import { buildLocalHttpRuntimeProjection } from './localConfigProjection';
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
  updateExtensions?: (patch: LocalServerExtensionStatePatch) => LocalServerDeps;
};

export function handleLocalHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LocalServerDeps,
  options: LocalHttpHandlerOptions,
) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const applyExtensionUpdate = (patch: LocalServerExtensionStatePatch): LocalServerDeps => {
    if (options.updateExtensions) return options.updateExtensions(patch);
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
        ...readAgentActivityHealthFields(),
      });
    };

    const refreshToolkitName = url.searchParams.get('refresh_toolkit');
    if (refreshToolkitName) {
      refreshToolkitAvailability(deps, refreshToolkitName).then(() => {
        writeHealth();
      }).catch((error: unknown) => {
        markToolkitUnavailable(
          deps,
          refreshToolkitName,
          error instanceof Error ? error.message : 'availability refresh failed',
        );
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
      const updatedDeps = applyExtensionUpdate(patch);
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

function markToolkitUnavailable(
  deps: LocalServerDeps,
  name: string,
  reason: string,
): void {
  deps.toolkitInventory.updateAvailability(name, { available: false, reason });
}

async function refreshToolkitAvailability(
  deps: LocalServerDeps,
  name: string,
): Promise<void> {
  await deps.toolkitInventory.refresh(name);
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
    } satisfies LocalServerExtensionStatePatch,
    summary: {
      loaded: userCapabilities.length,
    },
  };
}

function buildCapabilitiesPayload(
  deps: LocalServerDeps,
  threadId?: string,
) {
  const toolkitInventory = getLocalServerToolkitInventory(deps);
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
    toolkits: [...toolkitInventory.effectiveToolkits],
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
          toolkitInventory.entries,
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
