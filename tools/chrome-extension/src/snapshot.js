export const MAX_RAW_INTERACTIVE_ELEMENTS = 200;
export const MAX_RAW_TEXT_BYTES = 1_000_000;

export function originOf(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported page protocol: ${parsed.protocol}`);
  }
  return parsed.origin;
}

export function buildSnapshotExpression(maxInteractive = MAX_RAW_INTERACTIVE_ELEMENTS) {
  return `(() => {
    const maxInteractive = ${JSON.stringify(maxInteractive)};
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
      return {
        index,
        tag: element.tagName.toLowerCase(),
        text: trim((element.textContent || element.value || '').trim(), 80),
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

function axValue(node, key) {
  const value = node?.[key]?.value;
  return typeof value === 'string' ? value.trim() : '';
}

export function buildAccessibilitySnapshot(nodes, url) {
  const visibleNodes = nodes.filter((node) => !node.ignored);
  const root = visibleNodes.find((node) => axValue(node, 'role') === 'RootWebArea');
  const text = visibleNodes
    .filter((node) => ['StaticText', 'heading', 'paragraph'].includes(axValue(node, 'role')))
    .map((node) => axValue(node, 'name'))
    .filter(Boolean)
    .filter((value, index, values) => index === 0 || value !== values[index - 1])
    .join('\n');
  const interactiveRoles = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'menuitem',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
  ]);
  const candidates = visibleNodes.filter((node) => interactiveRoles.has(axValue(node, 'role')));
  const interactive = candidates.slice(0, MAX_RAW_INTERACTIVE_ELEMENTS).map((node, offset) => {
    const index = offset + 1;
    const role = axValue(node, 'role');
    const name = axValue(node, 'name');
    return {
      index,
      tag: role,
      text: name,
      type: null,
      placeholder: null,
      hint: `[${index}] ${role}${name ? ` "${name}"` : ''}`,
      ...(Number.isInteger(node.backendDOMNodeId) && node.backendDOMNodeId > 0
        ? { backendNodeId: node.backendDOMNodeId }
        : {}),
    };
  });
  return {
    title: axValue(root, 'name'),
    url,
    text,
    textLength: text.length,
    textSource: 'Accessibility.getFullAXTree',
    textUnavailableReason: text ? undefined : 'No readable accessibility text was returned',
    interactive,
    interactiveCount: candidates.length,
  };
}
