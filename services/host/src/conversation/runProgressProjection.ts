import { readCapabilityExecutions } from '@pinpawo/pet-agent';
import type { PetSessionRunProgress } from '../host/contracts';
import type { OrchestratorRunIdentity } from '../agent/activeRunRegister';

const credential = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:sk-[\w-]{12,}|gh[pousr]_[\w-]{12,}|github_pat_[\w-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[\w-]{12,})\b|\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}\b)/i;
const secretField = /(?:api[ _-]?key|password|secret|access[ _-]?token|authorization|密码|密钥|令牌)\s*[:=：]\s*\S+/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

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

/** Only a checkpoint for the causally bound graph run may enrich its live status. */
export function projectRunProgress(values: Record<string, unknown> | null, identity: OrchestratorRunIdentity): PetSessionRunProgress | undefined {
  const { runId, taskId } = identity;
  if (values?.runId !== runId || values.taskId !== taskId) return;
  let latestDelivery: string | undefined;
  try {
    const latest = readCapabilityExecutions(Array.isArray(values.messages) ? values.messages : [])
      .filter(({ metadata, result }) => metadata.runId === runId && metadata.taskId === taskId
        && result.status === 'returned' && result.delivery !== null).at(-1);
    latestDelivery = progressText(latest?.result.delivery?.text, 640);
  } catch {
    // An invalid execution record is not evidence. Ordinary status still works.
    return;
  }
  const supervisor = record(values.runSupervisorState);
  const pendingObjectives = supervisor?.runId === runId && Array.isArray(supervisor.plan)
    ? supervisor.plan.flatMap(item => {
      const entry = record(item);
      const objective = entry?.status === 'pending' ? progressText(entry.objective, 160) : undefined;
      return objective ? [objective] : [];
    }).slice(0, 3) : [];
  return latestDelivery || pendingObjectives.length ? {
    ...(latestDelivery ? { latestDelivery } : {}),
    ...(pendingObjectives.length ? { pendingObjectives } : {}),
  } : undefined;
}
