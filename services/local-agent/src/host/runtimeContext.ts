import type {
  AgentCapability,
  CapabilityArtifactStore,
  PetDocument,
  ToolkitRuntimeManager,
} from '@pinpawo/pet-agent';
import type { AgentRuntimeEvent, AgentServerMessage } from '@pinpawo/agent-session';

import type { ActiveRunRegister } from '../agent/activeRunRegister';
import type { LocalAgentGraphService } from '../agent/agentGraphService';
import type {
  AgentSessionTurnOptions,
  AgentSessionTurnResult,
} from '../agent/chatSessionAdapter';
import type { loadAgentContext } from '../contextLoader';
import type { createLocalServerHandlers, ServerHandlerOptions } from '../serverHandlers';
import type { LocalServerPeerHandlers } from '../wire/messageDispatcher';
import type { ServerTuiSessionService, TuiSessionCheckpointer } from '../session/serverTuiSessions';
import type { ServerRuntimeDepsStore } from '../serverTypes';
import type { HostExecutionConfig } from '../config/hostExecutionConfig';
import type { HostToolkitInventoryStore } from '../toolkits/toolkitInventory';
import type { LocalModelProfileRegistry } from '../config/llmConfig';
import type {
  AgentSessionPeer,
  PetDispatchLifecycleEvent,
} from './contracts';
import type { ResidentPetCoordinator } from './residentPetCoordinator';

/**
 * What the two surfaces share.
 *
 * `createResidentPet` and `createResidentPetInteraction` are constructed
 * independently but serve one Pet, so neither owns the runtime: they receive
 * an opaque `ResidentPetRuntime` handle and read this context from it. The
 * handle is branded and the map is private, so a surface cannot be built from
 * a runtime this module did not create.
 */

export type CreateResidentPetRuntimeOptions = HostExecutionConfig & {
  /** Host identity used for session ownership and graph isolation. */
  petId: string;
  petName: string;
  /** Optional attribution passed to Host tracing, outside the Agent contract. */
  traceUserId?: string;
  modelProfiles: LocalModelProfileRegistry;
  modelProfileId?: string;
  defaultCapabilityName?: string;
  petDocument?: PetDocument;
  capabilities: readonly AgentCapability[];
  toolkitInventory: HostToolkitInventoryStore;
  toolkitRuntimeManager?: ToolkitRuntimeManager;
  capabilityArtifactStore: CapabilityArtifactStore;
  checkpointer: TuiSessionCheckpointer;
  /** Pet-scoped Agent Session registry path owned by the composing Host. */
  sessionStatePath: string;
  loadContext?: typeof loadAgentContext;
  graphService?: LocalAgentGraphService;
  /** Shared Agent Session turn runner used by conversation and headless input. */
  runAgentTurn?: (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;
  /** Host persistence port for updated startup defaults. */
  persistGlobalReviewPolicyMode?: ServerHandlerOptions['persistGlobalReviewPolicyMode'];
  /** Existing opaque checkpoint thread, adopted only when no Agent Session exists. */
  adoptThreadId?: string;
};

export type CreateResidentPetHostOptions = CreateResidentPetRuntimeOptions;

declare const residentPetRuntimeBrand: unique symbol;

/** Opaque shared runtime context used to derive either resident surface. */
export interface ResidentPetRuntime {
  readonly petId: string;
  readonly [residentPetRuntimeBrand]: never;
}

export type ResidentPetRuntimeContext = {
  runtime: ResidentPetRuntime;
  runtimeDeps: ServerRuntimeDepsStore;
  graphService: LocalAgentGraphService;
  runAgentTurn: (options: AgentSessionTurnOptions) => Promise<AgentSessionTurnResult>;
  loadContext: typeof loadAgentContext;
  sessions: ServerTuiSessionService;
  coordinator: ResidentPetCoordinator;
  localHandlers: ReturnType<typeof createLocalServerHandlers>;
  peerHandlers: LocalServerPeerHandlers;
  /** One WebSocket client; passive readers and Host-owned HTTP commands do not claim it. */
  interactivePeer: { current: AgentSessionPeer | null };
  hostPeer: AgentSessionPeer;
  messageListeners: Set<(message: AgentServerMessage) => void>;
  publishRuntimeEvent: (event: AgentRuntimeEvent) => void;
  dispatchLifecycleListeners: Set<(event: PetDispatchLifecycleEvent) => void>;
  publishDispatchLifecycle: (event: PetDispatchLifecycleEvent) => void;
  activeHostRuns: Map<string, AbortController>;
  /** Shared with the local handlers: conversation and dispatch claim one register. */
  activeRuns: ActiveRunRegister;
  close: () => Promise<void>;
  isClosing: () => boolean;
};

const residentPetRuntimeContexts = new WeakMap<object, ResidentPetRuntimeContext>();

export function readResidentPetRuntimeContext(runtime: ResidentPetRuntime): ResidentPetRuntimeContext {
  const context = residentPetRuntimeContexts.get(runtime);
  if (!context) {
    throw new Error('Resident Pet runtime was not created by this local-agent runtime.');
  }
  return context;
}

/** Bind a freshly constructed context to its opaque handle. */
export function registerResidentPetRuntimeContext(
  runtime: ResidentPetRuntime,
  context: ResidentPetRuntimeContext,
): void {
  residentPetRuntimeContexts.set(runtime, context);
}
