import { readCapabilityExecutions } from '@pinpawo/pet-agent';
import type { PetSessionProgress } from '../host/contracts';
import type { AgentPlan } from '@pinpawo/agent-session';

const credential = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk-[\w-]{12,}|gh[pousr]_[\w-]{12,}|github_pat_[\w-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[\w-]{12,})\b|\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b)/i;
const secretField = /(?:api[ _-]?key|password|secret|access[ _-]?token|authorization|密码|密钥|令牌)\s*[:=：]\s*\S+/i;

/** Select prose only. Known secrets, private local paths and file references do not belong in progress. */
function progressText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return;
  if (credential.test(value) || secretField.test(value) || /^\s*[\[{]\s*[\[{"]/.test(value)) return;
  const text = value.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/!?\[[^\]\n]*\]\(\s*[a-z][a-z0-9+.-]*:\/\/[^)\n]*\)|\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]>]+|(?:~\/|\/(?:Users|home|private|tmp|var)\/)[^\s`"'\])]+/gi, '')
    .replace(/\s+/g, ' ').trim();
  if (!text) return;
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

/** Evidence from the already selected Session's checkpoint, not from the active request. */
export function projectSessionProgress(messages: readonly unknown[], recordedPlan: AgentPlan | null): PetSessionProgress | undefined {
  let latestDelivery: string | undefined;
  try {
    const latest = readCapabilityExecutions(messages)
      .filter(({ result }) => result.status === 'returned' && result.delivery !== null).at(-1);
    latestDelivery = progressText(latest?.result.delivery?.text, 640);
  } catch {
    // An invalid execution record is not evidence. Ordinary status still works.
    return;
  }
  const recordedPendingObjectives = (recordedPlan?.items ?? []).flatMap(({ task, status }) => {
    const objective = status !== 'completed' ? progressText(task, 160) : undefined;
    return objective ? [objective] : [];
  }).slice(0, 3);
  return latestDelivery || recordedPendingObjectives.length ? {
    ...(latestDelivery ? { latestDelivery } : {}),
    ...(recordedPendingObjectives.length ? { recordedPendingObjectives } : {}),
  } : undefined;
}
