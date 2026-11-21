import type { HeadDecision } from '../../../../packages/studio/src/host/petHead';
import type { EvalCase, Route } from './cases';
export type Score = { valid: boolean; route?: Route; dispatchPass: boolean; replyPresencePass: boolean; routePass: boolean; statusPass: boolean; pass: boolean; error?: string };

export function score(test: EvalCase, decision?: HeadDecision, error?: string): Score {
  const valid = !!decision && Object.keys(decision).every(key => ['action', 'reply'].includes(key))
    && (decision.reply == null || typeof decision.reply === 'string')
    && (decision.action === 'dispatch' || decision.action === 'direct'
      || ((decision.action === 'ignore' || decision.action === 'status') && !decision.reply?.trim()));
  if (!valid || !decision) return { valid: false, dispatchPass: false, replyPresencePass: false, routePass: false, statusPass: false,
    pass: false, error: error ?? 'invalid-decision' };
  const hasWork = decision.action === 'dispatch';
  const hasReply = !!decision.reply?.trim();
  // The eval scores the first decision's work disposition and immediate reply, not
  // Session reads or admissions. The Head runtime decides those from live facts.
  const route: Route = hasWork ? (hasReply ? 'combined' : 'dispatch-only') : (hasReply ? 'reply-only' : 'silent');
  const dispatchPass = test.routes.some(allowed => ['dispatch-only', 'combined'].includes(allowed) === hasWork);
  const replyPresencePass = test.routes.some(allowed => ['reply-only', 'combined'].includes(allowed) === hasReply);
  const routePass = test.routes.includes(route);
  const statusPass = (decision.action === 'status') === !!test.needsExecutionFacts;
  return { valid: true, route, dispatchPass, replyPresencePass, routePass, statusPass, pass: routePass && statusPass };
}

export function summarize(rows: Array<{ kind: EvalCase['kind']; score: Score }>) {
  const contrast = rows.filter(row => row.kind === 'contrast');
  const valid = contrast.filter(row => row.score.valid);
  return { total: rows.length, valid: rows.filter(row => row.score.valid).length,
    errors: rows.filter(row => !row.score.valid).length,
    contrast: { pass: contrast.filter(row => row.score.pass).length, total: contrast.length,
      conditionalDecisionPass: { pass: valid.filter(row => row.score.pass).length, total: valid.length },
      dispatchPass: contrast.filter(row => row.score.dispatchPass).length, replyPresencePass: contrast.filter(row => row.score.replyPresencePass).length,
      routePass: contrast.filter(row => row.score.routePass).length, statusPass: contrast.filter(row => row.score.statusPass).length },
    organic: { total: rows.length - contrast.length, accepted: rows.filter(row => row.kind === 'organic' && row.score.pass).length } };
}
