import type { HeadDecision } from '../../../../packages/studio/src/host/petHead';
import type { EvalCase, Route } from './cases';
export type Score = { valid: boolean; route?: Route; actionPass: boolean; replyPresencePass: boolean; routePass: boolean; timingPass: boolean; pass: boolean; error?: string };
export function score(test: EvalCase, value?: HeadDecision, error?: string): Score {
  const valid = !!value && Object.keys(value).length === 4 && typeof value.reply === 'string' && typeof value.intent === 'string'
    && ['enqueue', 'interrupt'].includes(value.timing) && ((value.action === 'ignore' && value.intent === '' && value.timing === 'enqueue') || (value.action === 'dispatch' && !!value.intent.trim()));
  if (!valid) return { valid: false, actionPass: false, replyPresencePass: false, routePass: false, timingPass: false, pass: false, error: error ?? 'invalid-decision' };
  const decision = value!;
  const route: Route = decision.action === 'dispatch' ? (decision.reply.trim() ? 'combined' : 'dispatch-only') : (decision.reply.trim() ? 'reply-only' : 'silent');
  const actionPass = test.routes.some(allowed => ['dispatch-only', 'combined'].includes(allowed) === (decision.action === 'dispatch'));
  const replyPresencePass = test.routes.some(allowed => ['reply-only', 'combined'].includes(allowed) === !!decision.reply.trim());
  const routePass = test.routes.includes(route), timingPass = test.timing.includes(decision.timing);
  return { valid: true, route, actionPass, replyPresencePass, routePass, timingPass, pass: routePass && timingPass };
}
export function summarize(rows: Array<{ kind: EvalCase['kind']; score: Score }>) {
  const contrast = rows.filter(row => row.kind === 'contrast');
  const valid = contrast.filter(row => row.score.valid);
  return { total: rows.length, valid: rows.filter(row => row.score.valid).length,
    errors: rows.filter(row => !row.score.valid).length,
    contrast: { pass: contrast.filter(row => row.score.pass).length, total: contrast.length,
      conditionalRoutingTiming: { pass: valid.filter(row => row.score.pass).length, total: valid.length },
      actionPass: contrast.filter(row => row.score.actionPass).length, replyPresencePass: contrast.filter(row => row.score.replyPresencePass).length,
      routePass: contrast.filter(row => row.score.routePass).length, timingPass: contrast.filter(row => row.score.timingPass).length },
    organic: { total: rows.length - contrast.length, accepted: rows.filter(row => row.kind === 'organic' && row.score.pass).length } };
}
