import type { EvalCase, Route } from './cases';
/** Only observed, synthetic-port effects; never a claim of real admission. */
export type Observation = { relevant: boolean; dispatched: boolean; hasReply: boolean };
export type Score = { valid: boolean; route?: Route; relevancePass: boolean; routePass: boolean; pass: boolean; error?: string };
export function score(test: EvalCase, value?: Observation, error?: string): Score {
  const valid = !!value && !error && typeof value.relevant === 'boolean' && typeof value.dispatched === 'boolean' && typeof value.hasReply === 'boolean';
  if (!valid || !value) return { valid: false, relevancePass: false, routePass: false, pass: false, error: error ?? 'invalid-observation' };
  const route: Route = value.dispatched ? (value.hasReply ? 'combined' : 'dispatch-only') : (value.hasReply ? 'reply-only' : 'silent');
  const relevancePass = test.relevance.includes(value.relevant);
  const routePass = test.routes.includes(route);
  return { valid: true, route, relevancePass, routePass, pass: relevancePass && routePass };
}
export function summarize(rows: Array<{ kind: EvalCase['kind']; score: Score }>) {
  const contrast = rows.filter(row => row.kind === 'contrast');
  const valid = contrast.filter(row => row.score.valid);
  return { total: rows.length, valid: rows.filter(row => row.score.valid).length, errors: rows.filter(row => !row.score.valid).length,
    contrast: { pass: contrast.filter(row => row.score.pass).length, total: contrast.length,
      conditionalPass: { pass: valid.filter(row => row.score.pass).length, total: valid.length },
      relevancePass: contrast.filter(row => row.score.relevancePass).length, routePass: contrast.filter(row => row.score.routePass).length },
    organic: { total: rows.length - contrast.length, accepted: rows.filter(row => row.kind === 'organic' && row.score.pass).length } };
}
