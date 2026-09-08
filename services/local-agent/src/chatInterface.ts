import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

export type AgentInterfaceKind = 'tui' | 'app-chat';
export const LOCAL_AGENT_INTERFACE_CONFIG_KEY = 'localAgentInterface';

export type AgentInterfaceCapabilities = {
  humanReview: boolean;
  sessionAuthorization: boolean;
};

export type AgentInterfaceContext = {
  threadId: string | null;
  kind: AgentInterfaceKind | null;
  capabilities: AgentInterfaceCapabilities;
};

const NO_CAPABILITIES: AgentInterfaceCapabilities = {
  humanReview: false,
  sessionAuthorization: false,
};

const TUI_CAPABILITIES: AgentInterfaceCapabilities = {
  humanReview: true,
  sessionAuthorization: true,
};

const APP_CHAT_CAPABILITIES: AgentInterfaceCapabilities = {
  humanReview: true,
  sessionAuthorization: true,
};

export function buildTuiChatThreadId(params: { petId: string; sessionSuffix: string }) {
  return `petbot:tui:pet:${params.petId}:${params.sessionSuffix}`;
}

export function buildStudioConversationId(params: { studioId: string; requestId: string }) {
  return `${params.studioId}:turn:${params.requestId}`;
}

export function buildAppChatThreadId(params: { petId: string; userId: string }) {
  return `petbot:chat:pet:${params.petId}:user:${params.userId}`;
}

export function readLocalAgentInterfaceCapabilities(
  kind: AgentInterfaceKind | null,
): AgentInterfaceCapabilities {
  if (kind === 'tui') return TUI_CAPABILITIES;
  if (kind === 'app-chat') return APP_CHAT_CAPABILITIES;
  return NO_CAPABILITIES;
}

function readInterfaceKind(value: unknown): AgentInterfaceKind | null {
  return value === 'tui' || value === 'app-chat' ? value : null;
}

function readThreadId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function buildLocalAgentInterfaceContext(params: {
  threadId?: string | null;
  kind?: AgentInterfaceKind | null;
}): AgentInterfaceContext {
  const kind = params.kind ?? null;
  return {
    threadId: readThreadId(params.threadId),
    kind,
    capabilities: readLocalAgentInterfaceCapabilities(kind),
  };
}

export function readLocalAgentInterfaceContext(value: unknown): AgentInterfaceContext {
  if (!value || typeof value !== 'object') {
    return buildLocalAgentInterfaceContext({});
  }
  const record = value as Record<string, unknown>;
  const kind = readInterfaceKind(record.kind);
  return buildLocalAgentInterfaceContext({
    kind,
    threadId: readThreadId(record.threadId),
  });
}

export function getCurrentLocalAgentInterface(): AgentInterfaceContext {
  const runnableConfig = AsyncLocalStorageProviderSingleton.getRunnableConfig();
  return readLocalAgentInterfaceContext(
    runnableConfig?.configurable?.[LOCAL_AGENT_INTERFACE_CONFIG_KEY],
  );
}
