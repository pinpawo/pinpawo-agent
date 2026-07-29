import type { AgentSession } from '@pinpawo/agent-session';
import { normalizeTerminalLine } from '../text/terminalText';

export const DEFAULT_AGENT_LABEL = 'PinPawo';

export function sessionActorLabel(session: AgentSession) {
  return normalizeAgentLabel(
    session.actor?.label,
    DEFAULT_AGENT_LABEL,
  );
}

export function normalizeAgentLabel(
  label: string | undefined,
  fallback: string,
) {
  const normalized = label?.trim();
  return normalized
    ? normalizeTerminalLine(normalized)
    : fallback;
}
