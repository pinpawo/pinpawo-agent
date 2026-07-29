import {
  BoxRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextAttributes,
  TextRenderable,
  type MarkdownOptions,
  type RenderContext,
} from '@opentui/core';

export type AssistantMarkdownSurface = {
  container: BoxRenderable;
  markdown: MarkdownRenderable;
};

export function createAssistantMarkdownStyle() {
  return SyntaxStyle.fromStyles({
    default: { fg: '#d7d7d7' },
    conceal: { fg: '#666666', dim: true },
    'markup.heading': { fg: '#5fd75f', bold: true },
    'markup.strong': { bold: true },
    'markup.italic': { italic: true },
    'markup.strikethrough': { dim: true },
    'markup.raw': { fg: '#69c0c8' },
    'markup.list': { fg: '#d7af5f' },
    'markup.link': { fg: '#69c0c8', underline: true },
    'markup.link.label': { fg: '#69c0c8', underline: true },
    'markup.link.url': { fg: '#69c0c8', dim: true },
    'markup.quote': { fg: '#a8a8a8', italic: true },
  });
}

export function createAssistantMarkdownSurface(
  context: RenderContext,
  options: {
    id: string;
    content: string;
    syntaxStyle: SyntaxStyle;
  },
): AssistantMarkdownSurface {
  const container = new BoxRenderable(context, {
    id: options.id,
    width: '100%',
    flexDirection: 'row',
    flexShrink: 0,
  });
  container.add(new TextRenderable(context, {
    id: `${options.id}:gutter`,
    width: 2,
    height: 1,
    flexShrink: 0,
    content: '| ',
    fg: '#5fd75f',
    attributes: TextAttributes.DIM,
  }));

  let renderedNodeSequence = 0;
  const nextNodeId = (kind: string) => (
    `${options.id}:${kind}:${renderedNodeSequence++}`
  );
  const renderNode: NonNullable<MarkdownOptions['renderNode']> = (token) => {
    if (token.type === 'heading') {
      return new TextRenderable(context, {
        id: nextNodeId('heading'),
        width: '100%',
        height: 'auto',
        content: token.text || ' ',
        fg: '#5fd75f',
        attributes: TextAttributes.BOLD,
      });
    }
    if (token.type === 'code') {
      return createCodeBlock(context, nextNodeId('code'), {
        language: token.lang,
        text: token.text,
      });
    }
    if (token.type === 'blockquote') {
      return createBlockquote(context, nextNodeId('quote'), token.text);
    }
    return null;
  };
  const markdown = new MarkdownRenderable(context, {
    id: `${options.id}:markdown`,
    width: '100%',
    flexGrow: 1,
    flexShrink: 1,
    content: options.content,
    syntaxStyle: options.syntaxStyle,
    conceal: true,
    concealCode: true,
    // OpenTUI's streaming path supplies synchronous StyledText while the
    // tree-sitter worker is still highlighting. Scrollback commits are
    // synchronous, so keep this enabled even for canonical completed entries.
    streaming: true,
    internalBlockMode: 'top-level',
    renderNode,
    tableOptions: {
      style: 'columns',
      widthMode: 'content',
      columnFitter: 'proportional',
      wrapMode: 'word',
      borders: false,
      selectable: true,
    },
  });
  container.add(markdown);
  return {
    container,
    markdown,
  };
}

export function stableAssistantMarkdownRows(
  surface: AssistantMarkdownSurface,
) {
  const stableBlocks = surface.markdown._blockStates.slice(
    0,
    surface.markdown._stableBlockCount,
  );
  const last = stableBlocks.at(-1);
  if (!last) {
    const onlyBlock = surface.markdown._blockStates.length === 1
      ? surface.markdown._blockStates[0]
      : undefined;
    if (
      onlyBlock
      && (
        onlyBlock.token.type === 'paragraph'
        || onlyBlock.token.type === 'code'
        || onlyBlock.token.type === 'blockquote'
      )
    ) {
      return Math.max(
        0,
        surface.container.y + surface.markdown.height - 1,
      );
    }
    return Math.max(0, surface.container.y);
  }
  return Math.max(
    0,
    surface.container.y + last.renderable.y + last.renderable.height,
  );
}

function createCodeBlock(
  context: RenderContext,
  id: string,
  code: {
    language?: string;
    text: string;
  },
) {
  const root = new BoxRenderable(context, {
    id,
    width: '100%',
    flexDirection: 'column',
    flexShrink: 0,
    border: ['left'],
    borderColor: '#4f7f86',
    paddingLeft: 1,
  });
  if (code.language?.trim()) {
    root.add(new TextRenderable(context, {
      id: `${id}:language`,
      width: '100%',
      height: 1,
      content: `code · ${code.language.trim()}`,
      fg: '#888888',
      attributes: TextAttributes.DIM,
    }));
  }
  const lines = code.text.split('\n');
  lines.forEach((line, index) => {
    root.add(new TextRenderable(context, {
      id: `${id}:line:${index}`,
      width: '100%',
      height: 'auto',
      content: line || ' ',
      fg: '#69c0c8',
    }));
  });
  return root;
}

function createBlockquote(
  context: RenderContext,
  id: string,
  text: string,
) {
  const root = new BoxRenderable(context, {
    id,
    width: '100%',
    flexDirection: 'column',
    flexShrink: 0,
    border: ['left'],
    borderColor: '#666666',
    paddingLeft: 1,
  });
  text.split('\n').forEach((line, index) => {
    root.add(new TextRenderable(context, {
      id: `${id}:line:${index}`,
      width: '100%',
      height: 'auto',
      content: line || ' ',
      fg: '#a8a8a8',
      attributes: TextAttributes.ITALIC,
    }));
  });
  return root;
}
