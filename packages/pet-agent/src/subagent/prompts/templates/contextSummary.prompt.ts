export const SUBAGENT_CONTEXT_SUMMARY_GOVERNING_PROMPT =
  'Earlier execution context is summarized automatically as it nears the model window limit; when continuing, rely on the summary and the recent messages.';

export const SUBAGENT_CONTEXT_SUMMARY_PREFIX = 'Earlier subagent context summary:';

export const SUBAGENT_CONTEXT_SUMMARY_PROMPT = [
  'Summarize the earlier subagent execution context below so the same subagent can continue the current delegated task.',
  'Always keep: the current task goal, completed work, key findings, explicit decisions, failures and limitations, and remaining work.',
  'Keep file paths, URLs, issue/PR numbers, commands, error messages and other evidence references as exact as possible.',
  'From raw tool output keep only the facts that affect later judgment; do not restate it passage by passage, and do not invent information that did not appear.',
  '',
  '{messages}',
].join('\n');
