function normalizeModelName(model: string) {
  return model.trim().toLowerCase().replace(/^models\//, '').replace(/^[^/]+\//, '');
}

function startsWithAny(model: string, prefixes: string[]) {
  return prefixes.some((prefix) => model.startsWith(prefix));
}

export function inferLlmContextWindowTokens(model: string | null | undefined): number | undefined {
  const normalized = model ? normalizeModelName(model) : '';
  if (!normalized) return undefined;

  if (
    startsWithAny(normalized, [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-chat',
      'deepseek-reasoner',
    ])
  ) {
    return 1_000_000;
  }

  if (startsWithAny(normalized, ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'])) {
    return 1_047_576;
  }

  if (
    startsWithAny(normalized, [
      'gpt-5.2',
      'gpt-5.1',
      'gpt-5-codex',
      'gpt-5.2-codex',
      'gpt-5.1-codex',
      'gpt-5.1-codex-mini',
      'gpt-5.2-codex-max',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5',
      'gpt-5-chat',
      'gpt-5.1-chat',
      'gpt-5.2-chat',
    ])
  ) {
    return 400_000;
  }

  if (startsWithAny(normalized, ['gpt-4o', 'gpt-4-turbo', 'gpt-4o-mini', 'gpt-4o-audio', 'gpt-4o-realtime'])) {
    return 128_000;
  }

  if (normalized === 'gpt-4' || normalized.startsWith('gpt-4.')) {
    return 8_192;
  }

  if (normalized.includes('claude-sonnet-4.5') || normalized.includes('claude-sonnet-4')) {
    return 1_000_000;
  }

  if (normalized.startsWith('claude-')) {
    return 200_000;
  }

  if (startsWithAny(normalized, ['gemini-3-', 'gemini-2.5-', 'gemini-2.0-'])) {
    return 1_048_576;
  }

  if (normalized.startsWith('gemini-1.5-pro')) {
    return 2_097_152;
  }

  if (normalized.startsWith('gemini-1.5-flash')) {
    return 1_048_576;
  }

  if (
    startsWithAny(normalized, [
      'qwen3.5-plus',
      'qwen3.5-flash',
      'qwen3.5-turbo',
      'qwen2.5-turbo',
      'qwen-turbo-latest',
      'qwen3-coder',
      'qwen3-',
      'qwen2.5-',
      'qwen2.5',
    ])
  ) {
    if (normalized.startsWith('qwen3.5-')) {
      return 1_000_000;
    }

    if (normalized.includes('qwen3-coder')) {
      return 256_000;
    }

    if (normalized.includes('qwen2.5-turbo') || /(?:^|[-_])1m(?:[-_]|$)/.test(normalized)) {
      return 1_000_000;
    }

    if (/(?:^|[-_])(0\.5b|1\.5b|3b)(?:[-_]|$)/.test(normalized)) {
      return 32_000;
    }

    if (/(?:^|[-_])(7b|14b|32b|72b)(?:[-_]|$)/.test(normalized)) {
      return 128_000;
    }

    return 128_000;
  }

  return undefined;
}
