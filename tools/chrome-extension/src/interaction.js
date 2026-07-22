export const ELEMENT_REGISTRY_KEY = '__pinpawoBrowserElementsV1';
export const HUMANIZED_TYPE_CHARACTER_LIMIT = 500;
export const TRUSTED_INSERT_CHUNK_CHARACTERS = 2_000;

const DEFAULT_HUMANIZATION = Object.freeze({
  preDelayMinMs: 40,
  preDelayMaxMs: 120,
  hoverMinMs: 60,
  hoverMaxMs: 180,
  keyDelayMinMs: 25,
  keyDelayMaxMs: 70,
});

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export function normalizeHumanization(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {
    preDelayMinMs: boundedInteger(input.preDelayMinMs, DEFAULT_HUMANIZATION.preDelayMinMs, 0, 2_000),
    preDelayMaxMs: boundedInteger(input.preDelayMaxMs, DEFAULT_HUMANIZATION.preDelayMaxMs, 0, 2_000),
    hoverMinMs: boundedInteger(input.hoverMinMs, DEFAULT_HUMANIZATION.hoverMinMs, 0, 2_000),
    hoverMaxMs: boundedInteger(input.hoverMaxMs, DEFAULT_HUMANIZATION.hoverMaxMs, 0, 2_000),
    keyDelayMinMs: boundedInteger(input.keyDelayMinMs, DEFAULT_HUMANIZATION.keyDelayMinMs, 0, 1_000),
    keyDelayMaxMs: boundedInteger(input.keyDelayMaxMs, DEFAULT_HUMANIZATION.keyDelayMaxMs, 0, 1_000),
  };
  for (const [minimumKey, maximumKey] of [
    ['preDelayMinMs', 'preDelayMaxMs'],
    ['hoverMinMs', 'hoverMaxMs'],
    ['keyDelayMinMs', 'keyDelayMaxMs'],
  ]) {
    if (result[minimumKey] > result[maximumKey]) {
      [result[minimumKey], result[maximumKey]] = [result[maximumKey], result[minimumKey]];
    }
  }
  return result;
}

export function randomDelayMs(minimum, maximum, random = Math.random) {
  if (maximum <= minimum) return minimum;
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

export function createSerialExecutor() {
  let tail = Promise.resolve();
  return function enqueue(work) {
    const result = tail.then(work, work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function chunkTrustedInsertText(
  text,
  chunkCharacters = TRUSTED_INSERT_CHUNK_CHARACTERS,
) {
  if (typeof text !== 'string') throw new Error('browser type text must be a string');
  if (!Number.isInteger(chunkCharacters) || chunkCharacters <= 0) {
    throw new Error('trusted insert chunk size must be a positive integer');
  }
  const characters = Array.from(text);
  const chunks = [];
  for (let offset = 0; offset < characters.length; offset += chunkCharacters) {
    chunks.push(characters.slice(offset, offset + chunkCharacters).join(''));
  }
  return chunks;
}

export function normalizeElementTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('browser element target must be an object');
  }
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  const selector = typeof value.selector === 'string' ? value.selector.trim() : '';
  if ((ref ? 1 : 0) + (selector ? 1 : 0) !== 1) {
    throw new Error('browser element target requires exactly one of ref or selector');
  }
  if (ref.length > 200 || selector.length > 2_000) {
    throw new Error('browser element target is too long');
  }
  return ref ? { ref } : { selector };
}

export function buildResolveTargetExpression(value) {
  const target = normalizeElementTarget(value);
  return `(() => {
    const target = ${JSON.stringify(target)};
    const registry = globalThis[${JSON.stringify(ELEMENT_REGISTRY_KEY)}];
    let element = target.ref ? registry?.get(target.ref) : null;
    if (!element && target.selector) {
      if (target.selector.startsWith('text=')) {
        const needle = target.selector.slice(5).trim();
        const candidates = Array.from(document.querySelectorAll(
          'a[href],button,input,textarea,select,[role="button"],[role="link"],[tabindex]'
        ));
        element = candidates.find((candidate) => {
          const text = (candidate.textContent || candidate.value || '').trim();
          return text === needle;
        }) || candidates.find((candidate) => {
          const text = (candidate.textContent || candidate.value || '').trim();
          return text.includes(needle);
        });
      } else {
        try { element = document.querySelector(target.selector); } catch { return {
          ok: false,
          code: 'invalid_selector',
          message: 'The CSS selector is invalid',
        }; }
      }
    }
    if (!element || !element.isConnected) return {
      ok: false,
      code: target.ref ? 'stale_element_reference' : 'element_not_found',
      message: target.ref ? 'The element reference is stale; take a new snapshot' : 'No element matched the selector',
    };
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') {
      return { ok: false, code: 'element_not_visible', message: 'The target element is not visible' };
    }
    return {
      ok: true,
      x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
      tag: element.tagName.toLowerCase(),
      editable: element.matches('input,textarea,[contenteditable="true"],[role="textbox"]'),
    };
  })()`;
}

export function buildExtractExpression(selector, offset, limit) {
  if (selector !== undefined && (typeof selector !== 'string' || selector.length > 2_000)) {
    throw new Error('browser extract selector must be a bounded string');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('browser extract offset must be a non-negative integer');
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100_000) {
    throw new Error('browser extract limit must be between 1 and 100000');
  }
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    let element = document.body;
    if (selector) {
      try { element = document.querySelector(selector); } catch { return {
        ok: false,
        code: 'invalid_selector',
        message: 'The CSS selector is invalid',
      }; }
      if (!element) return { ok: false, code: 'element_not_found', message: 'No element matched the selector' };
    }
    const sourceText = (element?.innerText || '').trim();
    const offset = Math.min(${offset}, sourceText.length);
    const limit = ${limit};
    return {
      ok: true,
      title: document.title,
      url: location.href,
      selector,
      text: sourceText.slice(offset, offset + limit),
      textLength: sourceText.length,
      offset,
      limit,
      textSource: selector ? 'element.innerText' : 'document.body.innerText',
    };
  })()`;
}
