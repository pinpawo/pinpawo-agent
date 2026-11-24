import type { EvalCase, Route } from './cases';
/** Only observed, synthetic-port effects; never a claim of real admission. */
export type Observation = { relevant: boolean; delivery: null | 'idle-only' | 'queue' | 'interrupt'; hasReply: boolean };
export type Score = { valid: boolean; route?: Route; relevancePass: boolean; deliveryPass: boolean; replyPass: boolean;
  routePass: boolean; pass: boolean; error?: string };
const dispatches = (route: Route) => route === 'dispatch-only' || route === 'combined';
const replies = (route: Route) => route === 'reply-only' || route === 'combined';
export function score(test: EvalCase, value?: Observation, error?: string): Score {
  const valid = !!value && !error && typeof value.relevant === 'boolean' && typeof value.hasReply === 'boolean' &&
    (value.delivery === null || value.delivery === 'idle-only' || value.delivery === 'queue' || value.delivery === 'interrupt');
  if (!valid || !value) return { valid: false, relevancePass: false, deliveryPass: false, replyPass: false,
    routePass: false, pass: false, error: error ?? 'invalid-observation' };
  const route: Route = value.delivery !== null ? (value.hasReply ? 'combined' : 'dispatch-only') : (value.hasReply ? 'reply-only' : 'silent');
  const relevancePass = test.relevance.includes(value.relevant);
  const expected = test.state === 'idle' ? 'idle-only' : test.state === 'busy' ? test.expectedDelivery : undefined;
  const deliveryPass = test.routes.some(route => value.delivery === (dispatches(route) ? expected : null));
  const replyPass = test.routes.some(route => value.hasReply === replies(route));
  // Separate diagnostics do not let an observation mix effects from different allowed routes.
  const routePass = deliveryPass && test.routes.includes(route);
  return { valid: true, route, relevancePass, deliveryPass, replyPass, routePass, pass: relevancePass && routePass };
}
export function summarize(rows: Array<{ kind: EvalCase['kind']; score: Score }>) {
  const contrast = rows.filter(row => row.kind === 'contrast');
  const valid = contrast.filter(row => row.score.valid);
  return { total: rows.length, valid: rows.filter(row => row.score.valid).length, errors: rows.filter(row => !row.score.valid).length,
    contrast: { pass: contrast.filter(row => row.score.pass).length, total: contrast.length,
      conditionalPass: { pass: valid.filter(row => row.score.pass).length, total: valid.length },
      relevancePass: contrast.filter(row => row.score.relevancePass).length,
      deliveryPass: contrast.filter(row => row.score.deliveryPass).length, replyPass: contrast.filter(row => row.score.replyPass).length,
      routePass: contrast.filter(row => row.score.routePass).length },
    organic: { total: rows.length - contrast.length, accepted: rows.filter(row => row.kind === 'organic' && row.score.pass).length } };
}
