import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';

export type LocalAgentInterfaceKind = 'tui' | 'app-chat';

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
  sessionAuthorization: false,
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

export function readLocalAgentInterfaceKind(threadId: string | null): LocalAgentInterfaceKind | null {
  if (!threadId) return null;
  if (threadId.startsWith('petbot:tui:')) return 'tui';
  if (threadId.startsWith('petbot:chat:')) return 'app-chat';
  return null;
}

export function readLocalAgentInterfaceCapabilities(
  kind: LocalAgentInterfaceKind | null,
): LocalAgentInterfaceCapabilities {
  if (kind === 'tui') return TUI_CAPABILITIES;
  if (kind === 'app-chat') return APP_CHAT_CAPABILITIES;
  return NO_CAPABILITIES;
}

export function getCurrentLocalAgentInterface(): LocalAgentInterfaceContext {
  const runnableConfig = AsyncLocalStorageProviderSingleton.getRunnableConfig();
  const threadId = runnableConfig?.configurable?.thread_id;
  const normalizedThreadId = typeof threadId === 'string' && threadId ? threadId : null;
  const kind = readLocalAgentInterfaceKind(normalizedThreadId);
  return {
    threadId: normalizedThreadId,
    kind,
    capabilities: readLocalAgentInterfaceCapabilities(kind),
  };
}
