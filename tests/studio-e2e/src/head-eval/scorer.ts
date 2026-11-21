import type { HeadDecision } from '../../../../packages/studio/src/host/petHead';
import type { EvalCase, Route } from './cases';
export type Score = { valid: boolean; route?: Route; workIntentPass: boolean; replyPresencePass: boolean; routePass: boolean; handlingPass: boolean; pass: boolean; error?: string };

export function score(test: EvalCase, decision?: HeadDecision, error?: string): Score {
  const valid = !!decision && Object.keys(decision).every(key => ['action', 'reply', 'intent'].includes(key))
    && (decision.reply == null || typeof decision.reply === 'string')
    && (decision.intent == null || typeof decision.intent === 'string')
    && (!decision.intent || (decision.action === 'handle' && !!decision.intent.trim()))
    && (decision.action === 'handle' || decision.action === 'direct'
      || (decision.action === 'pass' && !test.input.addressed && !decision.reply));
  if (!valid || !decision) return { valid: false, workIntentPass: false, replyPresencePass: false, routePass: false, handlingPass: false,
    pass: false, error: error ?? 'invalid-decision' };
  const hasWork = !!decision.intent?.trim();
  const hasReply = !!decision.reply?.trim();
  // The eval scores the first decision's work intent and immediate reply, not
  // Session reads or admissions. The Head runtime decides those from live facts.
  const route: Route = hasWork ? (hasReply ? 'combined' : 'dispatch-only') : (hasReply ? 'reply-only' : 'silent');
  const workIntentPass = test.routes.some(allowed => ['dispatch-only', 'combined'].includes(allowed) === hasWork);
  const replyPresencePass = test.routes.some(allowed => ['reply-only', 'combined'].includes(allowed) === hasReply);
  const routePass = test.routes.includes(route);
  const handlingPass = (decision.action === 'handle') === (hasWork || !!test.needsExecutionFacts);
  return { valid: true, route, workIntentPass, replyPresencePass, routePass, handlingPass, pass: routePass && handlingPass };
}

export function summarize(rows: Array<{ kind: EvalCase['kind']; score: Score }>) {
  const contrast = rows.filter(row => row.kind === 'contrast');
  const valid = contrast.filter(row => row.score.valid);
  return { total: rows.length, valid: rows.filter(row => row.score.valid).length,
    errors: rows.filter(row => !row.score.valid).length,
    contrast: { pass: contrast.filter(row => row.score.pass).length, total: contrast.length,
      conditionalDecisionPass: { pass: valid.filter(row => row.score.pass).length, total: valid.length },
      workIntentPass: contrast.filter(row => row.score.workIntentPass).length, replyPresencePass: contrast.filter(row => row.score.replyPresencePass).length,
      routePass: contrast.filter(row => row.score.routePass).length, handlingPass: contrast.filter(row => row.score.handlingPass).length },
    organic: { total: rows.length - contrast.length, accepted: rows.filter(row => row.kind === 'organic' && row.score.pass).length } };
}
