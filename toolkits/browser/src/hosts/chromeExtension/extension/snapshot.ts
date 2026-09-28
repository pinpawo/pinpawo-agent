import { ELEMENT_REGISTRY_KEY } from './interaction.js';
import type { JsonRecord } from './types.js';

/**
 * Page-side predicate for inputs whose value must never leave the page:
 * passwords, card data and one-time codes. Shared by the DOM snapshot, which
 * redacts them in place, and the accessibility snapshot, which cannot see
 * `autocomplete` and asks the page which nodes they are.
 */
const SENSITIVE_INPUT_PREDICATE = `const sensitiveInputTokens = new Set([
      'cc-csc',
      'cc-exp',
      'cc-exp-month',
      'cc-exp-year',
      'cc-number',
      'current-password',
      'new-password',
      'one-time-code',
    ]);
    const isSensitiveInput = (element) => {
      if (element.tagName.toLowerCase() !== 'input') return false;
      if ((element.getAttribute('type') || '').toLowerCase() === 'password') return true;
      const autocomplete = (element.getAttribute('autocomplete') || '')
        .toLowerCase()
        .split(/\\s+/)
        .filter(Boolean);
      return autocomplete.some((token) => sensitiveInputTokens.has(token));
    };`;

/**
 * An array of the page's sensitive inputs, including those inside open shadow
 * roots (the accessibility tree includes shadow content). Evaluated without
 * `returnByValue`, so the caller can map each element to its backend node.
 */
export function buildSensitiveInputsExpression(): string {
  return `(() => {
    ${SENSITIVE_INPUT_PREDICATE}
    const found = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (isSensitiveInput(element)) found.push(element);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    return found;
  })()`;
}

export const MAX_RAW_INTERACTIVE_ELEMENTS = 200;
export const MAX_RAW_TEXT_BYTES = 1_000_000;

export function originOf(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported page protocol: ${parsed.protocol}`);
  }
  return parsed.origin;
}

export function assertSnapshotApprovedOrigin(snapshot: JsonRecord, approvedOrigin: string): JsonRecord {
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.url !== 'string') {
    throw new Error('snapshot URL is unavailable');
  }
  if (originOf(snapshot.url) !== approvedOrigin) {
    throw new Error('snapshot URL does not match the approved origin');
  }
  return snapshot;
}

export function buildSnapshotExpression(maxInteractive = MAX_RAW_INTERACTIVE_ELEMENTS) {
  return `(() => {
    const maxInteractive = ${JSON.stringify(maxInteractive)};
    const snapshotId = globalThis.crypto?.randomUUID?.()
      || Date.now().toString(36) + Math.random().toString(36).slice(2);
    const elementRegistry = new Map();
    globalThis[${JSON.stringify(ELEMENT_REGISTRY_KEY)}] = elementRegistry;
    const trim = (value, length) => value.length <= length
      ? value
      : value.slice(0, length) + '...';
    const truncateUtf8 = (value, maxBytes) => {
      const encoder = new TextEncoder();
      if (encoder.encode(value).length <= maxBytes) return value;
      let low = 0;
      let high = value.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (encoder.encode(value.slice(0, middle)).length <= maxBytes) low = middle;
        else high = middle - 1;
      }
      return value.slice(0, low);
    };
    ${SENSITIVE_INPUT_PREDICATE}
    const textFor = (element) => {
      const text = (element.textContent || '').trim();
      if (text) return text;
      if (isSensitiveInput(element)) return '[redacted]';
      return String(element.value || '').trim();
    };
    const hintFor = (element, index) => {
      const label = element.getAttribute('aria-label');
      const name = element.getAttribute('name');
      const id = element.getAttribute('id');
      const text = trim((element.textContent || '').trim(), 48);
      const locator = id
        ? '#' + id
        : label
          ? '[aria-label="' + label.replaceAll('"', '\\"') + '"]'
          : name
            ? element.tagName.toLowerCase() + '[name="' + name.replaceAll('"', '\\"') + '"]'
            : text
              ? 'text=' + text
              : element.tagName.toLowerCase();
      return '[' + index + '] ' + locator;
    };
    const candidates = Array.from(document.querySelectorAll(
      'a[href],button,input,textarea,select,[role="button"],[role="link"],[tabindex]'
    )).filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none';
    });
    const interactive = candidates.slice(0, maxInteractive).map((element, offset) => {
      const index = offset + 1;
      const ref = snapshotId + ':' + index;
      elementRegistry.set(ref, element);
      return {
        index,
        ref,
        tag: element.tagName.toLowerCase(),
        text: trim(textFor(element), 80),
        type: element.getAttribute('type'),
        placeholder: element.getAttribute('placeholder'),
        hint: hintFor(element, index),
      };
    });
    const bodyText = (document.body?.innerText || '').trim();
    return {
      title: document.title,
      url: window.location.href,
      text: truncateUtf8(bodyText, ${MAX_RAW_TEXT_BYTES}),
      textLength: bodyText.length,
      textSource: 'Runtime.evaluate',
      interactive,
      interactiveCount: candidates.length,
    };
  })()`;
}

/** The DOM snapshot in the accessibility snapshot's shape, for when Chrome's tree is unavailable. */
export function buildDomTreeSnapshot(raw: JsonRecord) {
  const interactive = Array.isArray(raw.interactive) ? raw.interactive as JsonRecord[] : [];
  const lines: string[] = [];
  if (typeof raw.text === 'string' && raw.text.trim()) {
    lines.push(`- text: ${JSON.stringify(raw.text.replace(/\s+/g, ' ').trim())}`);
  }
  let refCount = 0;
  for (const element of interactive) {
    const tag = typeof element.tag === 'string' ? element.tag : 'element';
    const text = typeof element.text === 'string' && element.text
      ? ` ${JSON.stringify(element.text)}`
      : typeof element.placeholder === 'string' && element.placeholder
        ? ` ${JSON.stringify(element.placeholder)}`
        : '';
    const ref = typeof element.ref === 'string' ? element.ref : null;
    if (ref) refCount += 1;
    lines.push(`- ${tag}${text}${ref ? ` [ref=${ref}]` : ''}`);
  }
  const tree = lines.join('\n');
  const textLength = typeof raw.textLength === 'number' ? raw.textLength : 0;
  const returnedText = typeof raw.text === 'string' ? raw.text.length : 0;
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    url: raw.url,
    tree,
    treeLength: tree.length + Math.max(0, textLength - returnedText),
    refCount,
    source: 'dom' as const,
  };
}
