import React, { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder } from '@tiptap/extensions';
import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorContent, useEditor } from '@tiptap/react';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { channelMentionMarkdown, channelMentionMatches, type ChannelMentionCandidate } from './channelData';

export type ChannelMessageInputHandle = {
  /** Replace the draft, optionally starting with an @ for one member, and focus its end. */
  reset: (mention?: ChannelMentionCandidate) => void;
  focus: () => void;
};

type Props = {
  ref?: Ref<ChannelMessageInputHandle>;
  members: ChannelMentionCandidate[];
  disabled: boolean;
  placeholder: string;
  /** The draft as Channel Markdown: each @ is a `[@label](participant:id)` link. */
  onChange: (body: string) => void;
  onSubmit: () => void;
};

type Suggestion = { items: ChannelMentionCandidate[]; index: number; rect: DOMRect | null; command: (item: ChannelMentionCandidate) => void };

const listboxId = 'channel-mention-options';

/**
 * Message composer: a Tiptap editor whose `@` opens the member list inline. Only the Mention
 * node addresses a member; typed `@text` stays plain text, as in the Channel addressing rules.
 * Enter sends, Shift+Enter adds a line, and pasted text keeps its line breaks.
 */
export function ChannelMessageInput({ ref, members, disabled, placeholder, onChange, onSubmit }: Props) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const latest = useRef({ members, placeholder, onChange, onSubmit, suggestion });
  latest.current = { members, placeholder, onChange, onSubmit, suggestion };

  const editor = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editable: !disabled,
    extensions: [
      Document, Paragraph, Text, HardBreak,
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
      Mention.configure({
        HTMLAttributes: { class: 'channel-mention' },
        renderText: ({ node }) => channelMentionMarkdown({ participantId: node.attrs.id, label: node.attrs.label }),
        suggestion: {
          char: '@',
          items: ({ query }) => channelMentionMatches(latest.current.members, query),
          command: ({ editor: target, range, props }) => {
            const item = props as unknown as ChannelMentionCandidate;
            target.chain().focus().insertContentAt(range, [
              { type: 'mention', attrs: { id: item.participantId, label: item.label } }, { type: 'text', text: ' ' },
            ]).run();
          },
          render: () => {
            const show = (props: SuggestionProps<ChannelMentionCandidate>) => setSuggestion(current => ({
              items: props.items, rect: props.clientRect?.() ?? null, command: props.command,
              index: current && current.items.length === props.items.length ? Math.min(current.index, props.items.length - 1) : 0,
            }));
            return {
              onStart: show,
              onUpdate: show,
              onExit: () => setSuggestion(null),
              onKeyDown: ({ event }: SuggestionKeyDownProps) => {
                const open = latest.current.suggestion;
                if (event.key === 'Escape') { setSuggestion(null); return true; }
                if (!open?.items.length) return false;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  setSuggestion({ ...open, index: (open.index + step + open.items.length) % open.items.length });
                  return true;
                }
                if (event.key === 'Enter' || event.key === 'Tab') { open.command(open.items[open.index]); return true; }
                return false;
              },
            };
          },
        },
      }),
      Extension.create({
        name: 'channelSend',
        addKeyboardShortcuts: () => ({
          Enter: ({ editor: target }) => {
            if (target.view.composing || latest.current.suggestion?.items.length) return false;
            latest.current.onSubmit();
            return true;
          },
        }),
      }),
    ],
    editorProps: {
      attributes: {
        id: 'channel-message', class: 'channel-editor', role: 'textbox', 'aria-label': 'Message',
        'aria-multiline': 'true', 'aria-autocomplete': 'list',
      },
      // Keep every pasted line break: one paragraph of text and hard breaks, never merged blank lines.
      clipboardTextParser: (text, _context, _plain, view) => {
        const { schema } = view.state;
        const nodes = text.replace(/\r\n?/g, '\n').split('\n').flatMap((line, index) => [
          ...(index ? [schema.nodes.hardBreak.create()] : []), ...(line ? [schema.text(line)] : []),
        ]);
        return new Slice(Fragment.from(schema.nodes.paragraph.create(null, nodes)), 1, 1);
      },
    },
    onUpdate: ({ editor: target }) => latest.current.onChange(target.getText({ blockSeparator: '\n' })),
  });

  useEffect(() => { editor.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => {
    const element = editor.view.dom;
    if (suggestion) {
      element.setAttribute('aria-expanded', 'true');
      element.setAttribute('aria-controls', listboxId);
      if (suggestion.items.length) element.setAttribute('aria-activedescendant', `${listboxId}-${suggestion.index}`);
      else element.removeAttribute('aria-activedescendant');
    } else {
      element.setAttribute('aria-expanded', 'false');
      element.removeAttribute('aria-controls');
      element.removeAttribute('aria-activedescendant');
    }
  }, [editor, suggestion]);
  useImperativeHandle(ref, () => ({
    reset: mention => {
      editor.chain().setContent(mention ? [{ type: 'paragraph', content: [
        { type: 'mention', attrs: { id: mention.participantId, label: mention.label } }, { type: 'text', text: ' ' },
      ] }] : '', { emitUpdate: true }).focus('end').run();
    },
    focus: () => { editor.commands.focus('end'); },
  }), [editor]);

  return <div className="channel-editor-shell">
    <EditorContent editor={editor} />
    {suggestion && <ul id={listboxId} role="listbox" aria-label="Members to mention" className="channel-mention-menu"
      style={suggestion.rect ? { left: Math.max(8, Math.min(suggestion.rect.left, window.innerWidth - 268)), bottom: window.innerHeight - suggestion.rect.top + 6 } : undefined}>
      {suggestion.items.length ? suggestion.items.map((item, index) => <li key={item.participantId} id={`${listboxId}-${index}`} role="option"
        aria-selected={index === suggestion.index} className={index === suggestion.index ? 'active' : undefined}
        onMouseDown={event => { event.preventDefault(); suggestion.command(item); }}
        onMouseEnter={() => setSuggestion(current => current && { ...current, index })}>
        <span className={'channel-avatar small ' + item.kind} aria-hidden="true">{item.label.slice(0, 1).toUpperCase()}</span>
        <strong>{item.label}</strong><code>{item.participantId}</code>
      </li>) : <li className="channel-mention-empty" role="presentation">No matching member</li>}
    </ul>}
  </div>;
}
