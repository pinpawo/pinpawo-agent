import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentInputModality } from '@pinpawo/agent-session';
import { buildTuiChatThreadId } from './chatInterface';

export const DEFAULT_TUI_SESSION_STATE_PATH = resolve(homedir(), '.pinpawo', 'tui-sessions.json');

export type TuiSessionRecord = {
  id: string;
  petId: string;
  suffix: string;
  threadId: string;
  modelProfileId: string;
  requiredInputModalities: AgentInputModality[];
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TuiSessionState = {
  version: 4;
  activeSessionIds: Record<string, string>;
  sessions: Record<string, TuiSessionRecord>;
};

export type TuiSessionSummaryInput = {
  title?: string;
  messageCount?: number;
  updatedAt?: string;
};

export function createEmptyTuiSessionState(): TuiSessionState {
  return {
    version: 4,
    activeSessionIds: {},
    sessions: {},
  };
}

export function loadTuiSessionState(
  defaultModelProfileId: string,
  filePath = DEFAULT_TUI_SESSION_STATE_PATH,
): TuiSessionState {
  try {
    if (!existsSync(filePath)) return createEmptyTuiSessionState();
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    return parseTuiSessionState(parsed, defaultModelProfileId);
  } catch {
    return createEmptyTuiSessionState();
  }
}

export function saveTuiSessionState(
  state: TuiSessionState,
  filePath = DEFAULT_TUI_SESSION_STATE_PATH,
) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function ensureActiveTuiSession(
  state: TuiSessionState,
  petId: string,
  defaultModelProfileId: string,
  now = new Date(),
) {
  const activeId = state.activeSessionIds[petId];
  const active = activeId ? state.sessions[activeId] : undefined;
  if (active?.petId === petId) return active;
  return createTuiSession(state, petId, defaultModelProfileId, now);
}

export function createTuiSession(
  state: TuiSessionState,
  petId: string,
  defaultModelProfileId: string,
  now = new Date(),
) {
  const suffix = randomUUID().slice(0, 8);
  const id = `${petId}:${suffix}`;
  const timestamp = now.toISOString();
  const record: TuiSessionRecord = {
    id,
    petId,
    suffix,
    threadId: buildTuiChatThreadId({ petId, sessionSuffix: suffix }),
    modelProfileId: defaultModelProfileId,
    requiredInputModalities: ['text'],
    title: '新会话',
    messageCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.sessions[id] = record;
  state.activeSessionIds[petId] = id;
  return record;
}

export function resumeTuiSession(
  state: TuiSessionState,
  petId: string,
  sessionId: string,
) {
  const record = state.sessions[sessionId];
  if (!record || record.petId !== petId) return null;
  state.activeSessionIds[petId] = record.id;
  return record;
}

export function listTuiSessions(state: TuiSessionState, petId: string) {
  const activeId = state.activeSessionIds[petId];
  return Object.values(state.sessions)
    .filter((session) => session.petId === petId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((session) => ({
      ...session,
      active: session.id === activeId,
    }));
}

export function updateTuiSessionSummary(
  state: TuiSessionState,
  sessionId: string,
  summary: TuiSessionSummaryInput,
) {
  const record = state.sessions[sessionId];
  if (!record) return null;
  const next: TuiSessionRecord = {
    ...record,
    title: summary.title?.trim() || record.title,
    messageCount: summary.messageCount ?? record.messageCount,
    updatedAt: summary.updatedAt ?? record.updatedAt,
  };
  state.sessions[sessionId] = next;
  return next;
}

export function updateTuiSessionModelProfile(
  state: TuiSessionState,
  sessionId: string,
  modelProfileId: string,
) {
  const record = state.sessions[sessionId];
  if (!record) return null;
  const next: TuiSessionRecord = {
    ...record,
    modelProfileId,
    updatedAt: new Date().toISOString(),
  };
  state.sessions[sessionId] = next;
  return next;
}


function parseTuiSessionState(
  value: unknown,
  defaultModelProfileId: string,
): TuiSessionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptyTuiSessionState();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 2 && record.version !== 3 && record.version !== 4) {
    return createEmptyTuiSessionState();
  }
  return parseCurrentState(record, defaultModelProfileId, record.version);
}

function parseCurrentState(
  record: Record<string, unknown>,
  defaultModelProfileId: string,
  version: 2 | 3 | 4,
): TuiSessionState {
  const state = createEmptyTuiSessionState();
  const activeSessionIds = readRecord(record.activeSessionIds);
  const sessions = readRecord(record.sessions);
  for (const [petId, sessionId] of Object.entries(activeSessionIds ?? {})) {
    if (typeof sessionId === 'string' && sessionId) {
      state.activeSessionIds[petId] = sessionId;
    }
  }
  for (const [sessionId, rawSession] of Object.entries(sessions ?? {})) {
    const parsed = parseSessionRecord(
      sessionId,
      rawSession,
      version < 3 ? defaultModelProfileId : undefined,
      version < 4 ? ['text'] : undefined,
    );
    if (parsed) {
      state.sessions[parsed.id] = parsed;
    }
  }
  for (const [petId, activeId] of Object.entries(state.activeSessionIds)) {
    if (!state.sessions[activeId] || state.sessions[activeId]?.petId !== petId) {
      delete state.activeSessionIds[petId];
    }
  }
  return state;
}

function parseSessionRecord(
  id: string,
  value: unknown,
  migratedModelProfileId?: string,
  migratedInputModalities?: AgentInputModality[],
): TuiSessionRecord | null {
  const record = readRecord(value);
  if (!record) return null;
  const recordId = readString(record.id);
  const petId = readString(record.petId);
  const suffix = readString(record.suffix);
  const threadId = readString(record.threadId);
  const modelProfileId = readString(record.modelProfileId)
    ?? migratedModelProfileId
    ?? null;
  const requiredInputModalities = readInputModalities(
    record.requiredInputModalities,
  ) ?? migratedInputModalities ?? null;
  const title = readString(record.title);
  const messageCount = readNonNegativeInteger(record.messageCount);
  const createdAt = readString(record.createdAt);
  const updatedAt = readString(record.updatedAt);
  if (
    !recordId
    || recordId !== id
    || !petId
    || !suffix
    || recordId !== `${petId}:${suffix}`
    || !threadId
    || !modelProfileId
    || !requiredInputModalities
    || threadId !== buildTuiChatThreadId({ petId, sessionSuffix: suffix })
    || !title
    || messageCount === null
    || !createdAt
    || !updatedAt
  ) {
    return null;
  }
  return {
    id: recordId,
    petId,
    suffix,
    threadId,
    modelProfileId,
    requiredInputModalities,
    title,
    messageCount,
    createdAt,
    updatedAt,
  };
}

function readInputModalities(value: unknown): AgentInputModality[] | null {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value[0] !== 'text'
    || !value.every((item) => item === 'text' || item === 'image')
  ) {
    return null;
  }
  return [...new Set(value)] as AgentInputModality[];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function readNonNegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
