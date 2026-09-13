export function xmlTextBlock(tag: string, text: string, attrs = ''): string {
  const safeText = text.replaceAll(']]>', ']]]]><![CDATA[>');
  return [
    `<${tag}${attrs}>`,
    '<![CDATA[',
    safeText,
    ']]>',
    `</${tag}>`,
  ].join('\n');
}

export function indentXmlBlock(block: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  let inCdata = false;
  return block.split('\n').map((line) => {
    if (line.trim() === '<![CDATA[') {
      inCdata = true;
      return `${prefix}${line}`;
    }
    if (line.trim() === ']]>') {
      inCdata = false;
      return `${prefix}${line}`;
    }
    return inCdata ? line : `${prefix}${line}`;
  }).join('\n');
}

export function promptBlock(block: string | null | undefined, spaces: number): string {
  // A block owns its leading newline so optional template slots disappear cleanly.
  return block ? `\n${indentXmlBlock(block, spaces)}` : '';
}
