import { FormEvent, useEffect, useMemo, useState } from 'react';

type TaskStatus = 'waiting' | 'doing' | 'todo' | 'blocked' | 'done';

type Task = {
  taskId: string;
  assigneeId: string;
  brief: string;
  status: TaskStatus;
  deps: string[];
  note?: string;
  continuation?: {
    continuationId: string;
    payload: Record<string, unknown>;
  };
};

type EventItem = {
  id: string;
  time: string;
  source: string;
  type: string;
  taskId?: string;
  message: string;
  detail?: string;
};

type KanbanSnapshot = {
  tasks: Task[];
  lastEventSequence: number;
};

type KanbanHistoryEvent = {
  sequence: number;
  taskId: string;
  eventType: string;
  note?: string;
  occurredAt: string;
};

type StudioEvent = {
  type: string;
  source: string;
  payload?: { taskId?: unknown; note?: unknown };
  occurredAt: string;
};

type KnowledgeFile = {
  path: string;
  title: string;
  preview: string;
};

const statusOrder: TaskStatus[] = ['waiting', 'doing', 'todo', 'blocked', 'done'];

const studioHttpUrl = import.meta.env.VITE_STUDIO_HTTP_URL?.replace(/\/$/, '');
const studioHttpToken = import.meta.env.VITE_STUDIO_HTTP_TOKEN;

const knowledgeFiles: KnowledgeFile[] = [
  {
    path: 'project/brief.md',
    title: 'Project brief',
    preview: `# Project brief\n\n## Goal\nBuild a calm, auditable work loop around dispatch, events, task state, human authorization, and local Markdown context.\n\n## Scope\nThe Console is a client. It does not own the Kanban database or an Agent checkpoint.`,
  },
  {
    path: 'project/constraints.md',
    title: 'Constraints',
    preview: `# Constraints\n\n- No task board lanes or drag-and-drop\n- No direct database access from the browser\n- Knowledge remains a plain Markdown list and preview\n- Authorization remains an adapter command`,
  },
  {
    path: 'project/research-notes.md',
    title: 'Research notes',
    preview: `# Research notes\n\nThe first UI should make the active flow legible before it grows navigation, filtering, or editor features. Keep the event stream central.`,
  },
];

function statusLabel(status: TaskStatus): string {
  return status === 'todo' ? 'queued' : status;
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [selectedKnowledgePath, setSelectedKnowledgePath] = useState(knowledgeFiles[0].path);
  const [dispatchTarget, setDispatchTarget] = useState('');
  const [dispatchGoal, setDispatchGoal] = useState('');
  const [resumeDrafts, setResumeDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState(
    studioHttpUrl && studioHttpToken ? 'Connecting to Studio HTTP…' : 'Set VITE_STUDIO_HTTP_URL and VITE_STUDIO_HTTP_TOKEN to connect.',
  );
  const [connected, setConnected] = useState(false);

  const selectedKnowledge = knowledgeFiles.find((file) => file.path === selectedKnowledgePath) ?? knowledgeFiles[0];
  const selectedTask = tasks.find((task) => task.taskId === selectedTaskId);
  // 多个 Pet 可以各自停在自己的 continuation 上 —— 只渲染第一条会让其余的
  // 既看不见也无法恢复。
  const waitingTasks = tasks.filter((task) => task.status === 'waiting' && task.continuation);
  const visibleEvents = selectedTaskId
    ? events.filter((event) => event.taskId === selectedTaskId)
    : events;
  const groupedTasks = useMemo(
    () => statusOrder.map((status) => ({ status, tasks: tasks.filter((task) => task.status === status) })),
    [tasks],
  );

  useEffect(() => {
    if (!studioHttpUrl || !studioHttpToken) return undefined;
    const abort = new AbortController();
    let historySequence = 0;
    const headers = { Authorization: `Bearer ${studioHttpToken}` };

    const refresh = async () => {
      const [snapshotResponse, historyResponse] = await Promise.all([
        fetch(`${studioHttpUrl}/kanban`, { headers, signal: abort.signal }),
        fetch(`${studioHttpUrl}/kanban/events?after=${historySequence.toString()}`, {
          headers,
          signal: abort.signal,
        }),
      ]);
      if (!snapshotResponse.ok || !historyResponse.ok) {
        throw new Error(`Kanban HTTP request failed (${snapshotResponse.status.toString()}/${historyResponse.status.toString()}).`);
      }
      const snapshot = await snapshotResponse.json() as KanbanSnapshot;
      const history = await historyResponse.json() as { events: KanbanHistoryEvent[] };
      setTasks(snapshot.tasks);
      if (history.events.length > 0) {
        historySequence = history.events.at(-1)?.sequence ?? historySequence;
        setEvents((current) => [
          ...current,
          ...history.events.map((item) => ({
            id: `kanban-${item.sequence.toString()}`,
            time: new Date(item.occurredAt).toLocaleTimeString(),
            source: 'kanban',
            type: `task.${item.eventType}`,
            taskId: item.taskId,
            message: item.note ?? item.eventType,
          })),
        ].filter((item, index, items) => items.findIndex(({ id }) => id === item.id) === index));
      }
      setConnected(true);
      setNotice('Connected to Studio HTTP.');
    };

    const run = async () => {
      try {
        await refresh();
        const response = await fetch(`${studioHttpUrl}/events`, {
          headers,
          signal: abort.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Studio SSE request failed (${response.status.toString()}).`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        while (!abort.signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          pending += decoder.decode(next.value, { stream: true });
          let boundary = pending.indexOf('\n\n');
          while (boundary >= 0) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = block.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trimStart();
            if (data) {
              const event = JSON.parse(data) as StudioEvent;
              setEvents((current) => [...current, {
                id: `studio-${event.occurredAt}-${event.type}`,
                time: new Date(event.occurredAt).toLocaleTimeString(),
                source: event.source,
                type: event.type,
                taskId: typeof event.payload?.taskId === 'string' ? event.payload.taskId : undefined,
                message: typeof event.payload?.note === 'string' ? event.payload.note : event.type,
              }]);
              if (event.source === 'kanban') await refresh();
            }
            boundary = pending.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          setConnected(false);
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void run();
    return () => abort.abort();
  }, []);

  async function dispatch(input: Record<string, unknown>, petId: string): Promise<void> {
    if (!studioHttpUrl || !studioHttpToken) {
      setNotice('Studio HTTP connection is not configured.');
      return;
    }
    const response = await fetch(`${studioHttpUrl}/dispatch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${studioHttpToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ petId, input }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Studio dispatch failed (${response.status.toString()}).`);
    }
  }

  async function resumeContinuation(task: Task): Promise<void> {
    const continuation = task.continuation;
    if (!continuation) return;
    let payload: unknown;
    try {
      payload = JSON.parse(resumeDrafts[task.taskId] ?? '{}') as unknown;
    } catch {
      setNotice(`Resume payload for ${task.taskId} must be valid JSON.`);
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      setNotice(`Resume payload for ${task.taskId} must be a JSON object.`);
      return;
    }
    try {
      await dispatch({
        kind: 'resume',
        continuationId: continuation.continuationId,
        payload,
      }, task.assigneeId);
      setNotice(`Resume accepted for ${task.taskId}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function submitDispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const goal = dispatchGoal.trim();
    const target = dispatchTarget.trim();
    if (!goal || !target) {
      setNotice('Enter both a Pet target and a goal before dispatching.');
      return;
    }
    try {
      await dispatch({ kind: 'request', request: goal }, target);
      setDispatchGoal('');
      setNotice(`Dispatch accepted by ${target}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="console-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <span>kanban console</span>
          <span className="separator">/</span>
          <span className="instance-name">local control plane</span>
        </div>
        <div className="connection-state" title={notice}>
          <span className={`connection-dot ${connected ? 'connected' : ''}`} />
          {connected ? 'LIVE' : 'OFFLINE'}
        </div>
      </header>

      <section className="workspace" aria-label="Kanban Console prototype">
        <aside className="sidebar">
          <section className="task-panel panel">
            <div className="panel-heading">
              <span>TASKS</span>
              <span className="count">{tasks.length}</span>
            </div>
            <div className="task-groups">
              {groupedTasks.map((group) => (
                <div className={`task-group task-group-${group.status}`} key={group.status}>
                  <div className="group-label">
                    <span>{statusLabel(group.status)}</span>
                    <span>{group.tasks.length}</span>
                  </div>
                  {group.tasks.length > 0 && (group.status !== 'done' || selectedTask?.status === 'done') && (
                    <div className="task-list">
                      {group.tasks.map((task) => (
                        <button
                          className={`task-row ${selectedTaskId === task.taskId ? 'selected' : ''}`}
                          key={task.taskId}
                          onClick={() => setSelectedTaskId((current) => current === task.taskId ? undefined : task.taskId)}
                          title={task.note ?? task.brief}
                          type="button"
                        >
                          <span className={`status-dot status-${task.status}`} />
                          <span className="task-id">{task.taskId}</span>
                          <span className="task-copy">
                            <strong>{task.brief}</strong>
                            <small>{task.assigneeId}{task.note ? ` · ${task.note}` : ''}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="knowledge-panel panel">
            <div className="panel-heading">
              <span>KNOWLEDGE</span>
              <span className="read-only">READ ONLY</span>
            </div>
            <div className="knowledge-layout">
              <nav aria-label="Markdown files" className="knowledge-files">
                {knowledgeFiles.map((file) => (
                  <button
                    className={file.path === selectedKnowledge.path ? 'selected' : ''}
                    key={file.path}
                    onClick={() => setSelectedKnowledgePath(file.path)}
                    type="button"
                  >
                    <span>⌁</span>{file.path}
                  </button>
                ))}
              </nav>
              <article className="markdown-preview">
                <div className="file-path">{selectedKnowledge.path}</div>
                <pre>{selectedKnowledge.preview}</pre>
              </article>
            </div>
          </section>
        </aside>

        <section className="main-panel">
          <section className={`authorization panel ${waitingTasks.length > 0 ? '' : 'empty'}`}>
            <div className="authorization-label">
              CONTINUATION{waitingTasks.length > 1 ? ` · ${waitingTasks.length.toString()}` : ''}
            </div>
            {waitingTasks.length > 0 ? waitingTasks.map((task) => (
              <div className="authorization-entry" key={task.taskId}>
                <div className="authorization-copy">
                  <span className="status-dot status-waiting" />
                  <div>
                    <strong>{task.taskId} · {task.brief}</strong>
                    <p>{task.note ?? 'Pet is waiting for a continuation input.'}</p>
                  </div>
                </div>
                <div className="authorization-actions">
                  <textarea
                    aria-label={`Opaque continuation payload for ${task.taskId}`}
                    onChange={(event) => setResumeDrafts((drafts) => ({
                      ...drafts,
                      [task.taskId]: event.target.value,
                    }))}
                    value={resumeDrafts[task.taskId] ?? '{\n  \n}'}
                  />
                  <button
                    className="approve-button"
                    onClick={() => void resumeContinuation(task)}
                    type="button"
                  >
                    RESUME
                  </button>
                </div>
              </div>
            )) : (
              <p>No Pet continuation is waiting.</p>
            )}
          </section>

          <section className="events panel">
            <div className="panel-heading events-heading">
              <span>EVENTS</span>
              <div>
                {selectedTaskId && <span className="filter-label">FILTER: {selectedTaskId}</span>}
                {selectedTaskId && <button onClick={() => setSelectedTaskId(undefined)} type="button">SHOW ALL</button>}
              </div>
            </div>
            <div className="event-columns" aria-hidden="true">
              <span>TIME</span><span>SOURCE</span><span>TYPE</span><span>TASK</span><span>MESSAGE</span>
            </div>
            <div className="event-stream">
              {visibleEvents.map((item) => (
                <div className={`event-item ${selectedEventId === item.id ? 'expanded' : ''}`} key={item.id}>
                  <button className="event-row" onClick={() => setSelectedEventId((current) => current === item.id ? undefined : item.id)} type="button">
                    <time>{item.time}</time>
                    <span className="event-source">{item.source}</span>
                    <span className="event-type">{item.type}</span>
                    <span className="event-task">{item.taskId ?? '—'}</span>
                    <span className="event-message">{item.message}</span>
                  </button>
                  {selectedEventId === item.id && item.detail && <p className="event-detail">{item.detail}</p>}
                </div>
              ))}
              {visibleEvents.length === 0 && <p className="empty-stream">No events belong to {selectedTaskId} yet.</p>}
            </div>
          </section>
        </section>
      </section>

      <form className="dispatch-bar" onSubmit={submitDispatch}>
        <label htmlFor="dispatch-target">DISPATCH</label>
        <input id="dispatch-target" onChange={(event) => setDispatchTarget(event.target.value)} placeholder="pet id" value={dispatchTarget} />
        <input aria-label="Dispatch goal" onChange={(event) => setDispatchGoal(event.target.value)} placeholder="Describe the next goal…" value={dispatchGoal} />
        <button type="submit">SEND</button>
      </form>
    </main>
  );
}
