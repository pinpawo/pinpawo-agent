import { cases } from './cases';

/** Selection validation is offline and must finish before profile resolution. */
export function selectCases(ids: string[] | undefined, repeats: number) {
  if (ids?.some(id => !cases.some(test => test.id === id))) throw new Error('unknown-case');
  const selected = cases.filter(test => !ids || ids.includes(test.id));
  if (!Number.isInteger(repeats) || repeats < 1 || !selected.length || selected.length * repeats > 20) {
    throw new Error('maximum-20-decisions');
  }
  return selected;
}
