import {
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
  type ScrollbackSurface,
} from '@opentui/core';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import {
  countSettledTimelinePrefix,
  formatTimelineEntry,
} from './timelineModel';

type ActiveSurface = {
  surface: ScrollbackSurface;
  stable: TextRenderable;
  pending: TextRenderable;
};

export class TimelineScrollback {
  private sessionId: string | null = null;
  private committedFingerprints: string[] = [];
  private activeSurface: ActiveSurface | null = null;

  constructor(private readonly renderer: CliRenderer) {}

  render(session: AgentSession) {
    if (session.sessionId !== this.sessionId) {
      const previousSessionId = this.sessionId;
      this.destroySurface();
      this.sessionId = session.sessionId;
      this.committedFingerprints = [];
      if (previousSessionId && previousSessionId !== 'pending') {
        this.writeSessionSeparator(session.sessionId);
      }
    }

    const firstUncommitted = findFirstUncommittedEntry(
      session.timeline,
      this.committedFingerprints,
    );
    const settledEnd = countSettledTimelinePrefix(
      session.timeline,
      firstUncommitted,
    );
    const settled = session.timeline.slice(firstUncommitted, settledEnd);
    const pending = session.timeline.slice(settledEnd);

    if (settled.length === 0 && pending.length === 0) {
      this.destroySurface();
      return;
    }

    const active = this.ensureSurface();
    active.stable.content = joinEntries(settled);
    active.stable.height = settled.length ? 'auto' : 0;
    active.pending.content = joinEntries(pending);
    active.pending.height = pending.length ? 'auto' : 0;
    active.surface.render();

    if (settled.length === 0) {
      return;
    }

    const settledRows = active.stable.height;
    if (typeof settledRows !== 'number' || settledRows < 1) {
      throw new Error('OpenTUI did not measure settled timeline rows');
    }
    active.surface.commitRows(0, settledRows);
    this.committedFingerprints.push(...settled.map(timelineFingerprint));
    this.destroySurface();

    if (pending.length > 0) {
      this.render(session);
    }
  }

  destroy() {
    this.destroySurface();
  }

  private ensureSurface() {
    if (this.activeSurface && !this.activeSurface.surface.isDestroyed) {
      return this.activeSurface;
    }
    const surface = this.renderer.createScrollbackSurface({ startOnNewLine: true });
    const column = new BoxRenderable(surface.renderContext, {
      id: 'timeline-surface',
      width: '100%',
      height: 'auto',
      flexDirection: 'column',
    });
    const stable = new TextRenderable(surface.renderContext, {
      id: 'timeline-settled',
      width: '100%',
      height: 0,
      content: '',
    });
    const pending = new TextRenderable(surface.renderContext, {
      id: 'timeline-pending',
      width: '100%',
      height: 0,
      content: '',
    });
    column.add(stable);
    column.add(pending);
    surface.root.add(column);
    this.activeSurface = { surface, stable, pending };
    return this.activeSurface;
  }

  private destroySurface() {
    if (this.activeSurface && !this.activeSurface.surface.isDestroyed) {
      this.activeSurface.surface.destroy();
    }
    this.activeSurface = null;
  }

  private writeSessionSeparator(sessionId: string) {
    this.renderer.writeToScrollback((context) => {
      const content = `\n── session ${sessionId} ──`;
      const text = new TextRenderable(context.renderContext, {
        id: `session-${sessionId}`,
        width: context.width,
        height: 2,
        content,
        fg: '#8a8a8a',
      });
      return {
        root: text,
        width: context.width,
        height: 2,
      };
    });
  }
}

export function findFirstUncommittedEntry(
  timeline: readonly AgentTimelineEntry[],
  committedFingerprints: readonly string[],
) {
  let committedCursor = 0;
  for (let index = 0; index < timeline.length; index += 1) {
    const fingerprint = timelineFingerprint(timeline[index]!);
    const match = committedFingerprints.indexOf(fingerprint, committedCursor);
    if (match < 0) {
      return index;
    }
    committedCursor = match + 1;
  }
  return timeline.length;
}

export function timelineFingerprint(entry: AgentTimelineEntry) {
  if (entry.type === 'message') {
    return JSON.stringify([
      'message',
      entry.role,
      normalizeText(entry.text),
    ]);
  }
  return JSON.stringify([
    'operation',
    entry.kind,
    normalizeText(entry.title),
    normalizeText(entry.target ?? ''),
    normalizeText(entry.summary ?? ''),
    entry.phase,
  ]);
}

function joinEntries(entries: readonly AgentTimelineEntry[]) {
  return entries.map(formatTimelineEntry).join('\n');
}

function normalizeText(value: string) {
  return value.trim().replace(/\r\n/g, '\n');
}
