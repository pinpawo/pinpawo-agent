import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BoxRenderable, ScrollBoxRenderable, TextRenderable, createCliRenderer,
  type CliRenderer,
} from '@opentui/core';
import type { AgentSession, AgentTimelineEntry } from '@pinpawo/agent-session';
import { createAssistantMarkdownStyle, createAssistantMarkdownSurface } from './assistantMarkdown';

type Message = Extract<AgentTimelineEntry, { type: 'message' }>;

/** The list stays mounted while reading, preserving selection and scroll. */
export class MessageViewer {
  readonly frame: BoxRenderable;
  readonly list: ScrollBoxRenderable;
  readonly reader: ScrollBoxRenderable;
  private readonly title: TextRenderable;
  private readonly hint: TextRenderable;
  private readonly style = createAssistantMarkdownStyle();
  private readonly messages: Message[];
  private selected: number;
  private reading = false;

  constructor(private readonly renderer: CliRenderer, session: AgentSession) {
    // Freeze a coherent snapshot: live output continues in the suspended parent.
    this.messages = session.timeline.filter((entry): entry is Message => entry.type === 'message' && entry.role !== 'subagent')
      .map((entry) => ({ ...entry }));
    this.selected = Math.max(0, this.messages.length - 1);
    this.frame = new BoxRenderable(renderer, {
      id: 'message-viewer', width: '100%', height: '100%', flexDirection: 'column',
      backgroundColor: '#191d23',
    });
    this.title = new TextRenderable(renderer, { id: 'message-viewer-title', height: 1, fg: '#69c0c8' });
    this.hint = new TextRenderable(renderer, { id: 'message-viewer-hint', height: 1, fg: '#8f9ba8' });
    this.list = new ScrollBoxRenderable(renderer, {
      id: 'message-list', width: '100%', flexGrow: 1, flexShrink: 1, scrollX: false,
      contentOptions: { flexDirection: 'column' },
    });
    this.reader = new ScrollBoxRenderable(renderer, {
      id: 'message-reader', width: '100%', flexGrow: 1, flexShrink: 1, scrollX: false,
      visible: false, contentOptions: { flexDirection: 'column' },
    });
    this.messages.forEach((message, index) => this.list.add(new TextRenderable(renderer, {
      id: `message-choice:${index}`, width: '100%', height: 'auto', flexShrink: 0,
      content: `${message.role} · ${message.status}  ${message.text.replace(/\s+/g, ' ').slice(0, 140) || '(empty)'}`,
    })));
    this.frame.add(this.title);
    this.frame.add(this.list);
    this.frame.add(this.reader);
    this.frame.add(this.hint);
    this.refreshSelection();
    // Child positions are available only after the first layout frame.
    renderer.once('frame', () => {
      if (!this.reading) this.refreshSelection();
    });
  }

  /** Return true only when the outer browser should close. All keys are owned here. */
  handleKey(key: { name: string; ctrl?: boolean; meta?: boolean; option?: boolean }) {
    if (key.name === 'escape') {
      if (!this.reading) return true;
      this.reading = false;
      this.reader.visible = false;
      this.list.visible = true;
      this.refreshSelection(false);
      return false;
    }
    if (key.ctrl || key.meta || key.option) return false;
    if (this.reading) {
      const page = Math.max(1, this.reader.viewport.height - 1);
      if (key.name === 'up' || key.name === 'k') this.reader.scrollBy(-1);
      if (key.name === 'down' || key.name === 'j') this.reader.scrollBy(1);
      if (key.name === 'pageup') this.reader.scrollBy(-page);
      if (key.name === 'pagedown') this.reader.scrollBy(page);
      if (key.name === 'home') this.reader.scrollTo(0);
      if (key.name === 'end') this.reader.scrollTo(this.reader.scrollHeight);
      return false;
    }
    const page = Math.max(1, this.list.viewport.height - 1);
    let delta = 0;
    if (key.name === 'up' || key.name === 'k') delta = -1;
    if (key.name === 'down' || key.name === 'j') delta = 1;
    if (key.name === 'pageup') delta = -page;
    if (key.name === 'pagedown') delta = page;
    if (key.name === 'home') delta = -this.messages.length;
    if (key.name === 'end') delta = this.messages.length;
    if (delta) {
      this.selected = Math.max(0, Math.min(this.messages.length - 1, this.selected + delta));
      this.refreshSelection();
    }
    if (key.name === 'return' && this.messages[this.selected]) this.openMessage();
    return false;
  }

  destroy() { this.style.destroy(); }

  private refreshSelection(scroll = true) {
    this.title.content = `Timeline messages · ${this.messages.length} · snapshot`;
    this.hint.content = '↑↓ select · Enter read · Esc back';
    this.list.getChildren().forEach((child, index) => {
      (child as TextRenderable).fg = index === this.selected ? '#5fd75f' : '#d7d7d7';
      (child as TextRenderable).bg = index === this.selected ? '#272c33' : '#191d23';
    });
    if (scroll && this.messages.length) this.list.scrollChildIntoView(`message-choice:${this.selected}`);
    if (!this.messages.length) this.title.content = 'Timeline messages · no messages yet';
  }

  private openMessage() {
    for (const child of this.reader.getChildren()) {
      this.reader.remove(child);
      child.destroyRecursively();
    }
    const message = this.messages[this.selected]!;
    const surface = createAssistantMarkdownSurface(this.renderer, {
      id: `message-fullscreen:${this.selected}`, content: message.text || '(empty)', syntaxStyle: this.style,
    });
    this.reader.add(surface.container);
    this.reader.scrollTo(0);
    this.reading = true;
    this.list.visible = false;
    this.reader.visible = true;
    this.title.content = `${message.role} · ${this.selected + 1}/${this.messages.length} · ${message.status} · snapshot`;
    this.hint.content = '↑↓ scroll · PgUp/PgDn · Home/End · Esc back';
  }
}

/** Alternate screen leaves the main terminal's timeline scrollback untouched. */
export async function browseTimelineMessages(session: AgentSession) {
  const renderer = await createCliRenderer({
    screenMode: 'alternate-screen', exitOnCtrlC: false, useMouse: false,
    consoleMode: 'disabled',
  });
  const view = new MessageViewer(renderer, session);
  renderer.root.add(view.frame);
  try {
    await new Promise<void>((resolve) => {
      renderer.keyInput.on('keypress', (key) => {
        key.preventDefault();
        key.stopPropagation();
        if (view.handleKey(key)) resolve();
      });
      renderer.keyInput.on('paste', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      renderer.once('destroy', resolve);
    });
  } finally {
    renderer.destroy();
    view.destroy();
  }
}

/** A separate process is required because OpenTUI exclusively owns stdin. */
export async function pageTimelineMessages(session: AgentSession) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pinpawo-message-viewer-'));
  try {
    const file = path.join(dir, 'messages.json');
    await writeFile(file, JSON.stringify({
      sessionId: session.sessionId, kind: session.kind, activeRun: null, pendingInterrupt: null,
      timeline: session.timeline.filter((entry) => entry.type === 'message' && entry.role !== 'subagent'),
    }), { mode: 0o600 });
    const args = Bun.main.startsWith('/$bunfs/') ? [] : [Bun.main];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [...args, '--message-viewer', file], { stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`message viewer exited: ${signal ?? code}`));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
