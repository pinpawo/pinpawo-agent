/** Offline design contrasts, NOT scored by the current runtime-effect evaluator.
 * Relation is semantic evidence, not permission to stop or dispatch execution.
 * Keep expected relations and descriptive case IDs outside model-visible input.
 */
export const relevanceCases = [
  { id: 'replacement', input: { previous: { messageId: 'm-4f8a', body: 'A：核对季度报告。' },
    message: { messageId: 'm-7c31', body: 'A先不做了，做B。B：整理下周指标清单。' } },
    expected: { relevant: true, relation: 'replacement', preserveA: false, bAfterA: false } },
  { id: 'ordered', input: { previous: { messageId: 'm-4f8a', body: 'A：核对季度报告。' },
    message: { messageId: 'm-7c31', body: 'A继续，做完再做B。B：整理下周指标清单。' } },
    expected: { relevant: true, relation: 'ordered', preserveA: true, bAfterA: true } },
  { id: 'guidance', input: { previous: { messageId: 'm-4f8a', body: 'A：核对季度报告。' },
    message: { messageId: 'm-7c31', body: 'A继续，另外做B。B：整理下周指标清单。' } },
    expected: { relevant: true, relation: 'guidance', preserveA: true, bAfterA: false } },
] as const;
