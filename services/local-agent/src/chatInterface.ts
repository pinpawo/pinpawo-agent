import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

export type LocalAgentInterfaceKind = 'tui' | 'app-chat';
export const LOCAL_AGENT_INTERFACE_CONFIG_KEY = 'localAgentInterface';

export type LocalAgentInterfaceCapabilities = {
  humanReview: boolean;
  sessionAuthorization: boolean;
};

export type LocalAgentInterfaceContext = {
  threadId: string | null;
  kind: LocalAgentInterfaceKind | null;
  capabilities: LocalAgentInterfaceCapabilities;
};

const NO_CAPABILITIES: LocalAgentInterfaceCapabilities = {
  humanReview: false,
  sessionAuthorization: false,
};

const TUI_CAPABILITIES: LocalAgentInterfaceCapabilities = {
  humanReview: true,
  sessionAuthorization: true,
};

const APP_CHAT_CAPABILITIES: LocalAgentInterfaceCapabilities = {
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
  kind: LocalAgentInterfaceKind | null,
): LocalAgentInterfaceCapabilities {
  if (kind === 'tui') return TUI_CAPABILITIES;
  if (kind === 'app-chat') return APP_CHAT_CAPABILITIES;
  return NO_CAPABILITIES;
}

function readInterfaceKind(value: unknown): LocalAgentInterfaceKind | null {
  return value === 'tui' || value === 'app-chat' ? value : null;
}

function readThreadId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function buildLocalAgentInterfaceContext(params: {
  threadId?: string | null;
  kind?: LocalAgentInterfaceKind | null;
}): LocalAgentInterfaceContext {
  const kind = params.kind ?? null;
  return {
    threadId: readThreadId(params.threadId),
    kind,
    capabilities: readLocalAgentInterfaceCapabilities(kind),
  };
}

export function readLocalAgentInterfaceContext(value: unknown): LocalAgentInterfaceContext {
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

export function getCurrentLocalAgentInterface(): LocalAgentInterfaceContext {
  const runnableConfig = AsyncLocalStorageProviderSingleton.getRunnableConfig();
  return readLocalAgentInterfaceContext(
    runnableConfig?.configurable?.[LOCAL_AGENT_INTERFACE_CONFIG_KEY],
  );
}
