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
  payload?: {
    taskId?: unknown;
    note?: unknown;
    dispatch?: unknown;
  };
  occurredAt: string;
};

type DispatchStatus = 'queued' | 'busy' | 'completed' | 'waiting' | 'failed' | 'cancelled';

type DispatchItem = {
  petId: string;
  threadId: string;
  invocationId: string;
  input:
    | { kind: 'request'; request: string }
    | { kind: 'resume'; continuationId: string };
  status: DispatchStatus;
  submittedAt: string;
  updatedAt: string;
  output?: string;
  error?: string;
};

type DispatchesSnapshot = { dispatches: DispatchItem[] };

type StudioPetRegistration = {
  petId: string;
  name: string;
  role?: string | null;
  serviceSummary?: string | null;
  startupMode: 'standby' | 'lazy' | 'disabled';
  status: 'disabled' | 'loading' | 'standby' | 'active' | 'degraded' | 'unavailable';
  capabilities: Array<{
    name: string;
    description: string;
    available: boolean;
    reason?: string | null;
  }>;
};

type StudioPetsSnapshot = { pets: StudioPetRegistration[] };

type KnowledgeFile = {
  path: string;
  title: string;
  preview: string;
};

const statusOrder: TaskStatus[] = ['waiting', 'doing', 'todo', 'blocked', 'done'];

const studioHttpUrl = import.meta.env.VITE_STUDIO_HTTP_URL?.replace(/\/$/, '')
  ?? window.location.origin;
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

function isDispatchItem(value: unknown): value is DispatchItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<DispatchItem>;
  return typeof record.invocationId === 'string'
    && typeof record.petId === 'string'
    && typeof record.threadId === 'string'
    && typeof record.status === 'string'
    && typeof record.submittedAt === 'string'
    && typeof record.updatedAt === 'string'
    && !!record.input
    && typeof record.input === 'object';
}

function dispatchSummary(item: DispatchItem): string {
  return item.input.kind === 'request'
    ? item.input.request
    : `Resume ${item.input.continuationId}`;
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pets, setPets] = useState<StudioPetRegistration[]>([]);
  const [dispatches, setDispatches] = useState<DispatchItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedContinuationTaskId, setSelectedContinuationTaskId] = useState<string>();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [selectedKnowledgePath, setSelectedKnowledgePath] = useState(knowledgeFiles[0].path);
  const [dispatchTarget, setDispatchTarget] = useState('');
  const [dispatchGoal, setDispatchGoal] = useState('');
  const [resumePayload, setResumePayload] = useState('{\n  \n}');
  const [notice, setNotice] = useState(
    'Connecting to Studio HTTP…',
  );
  const [connected, setConnected] = useState(false);

  const selectedKnowledge = knowledgeFiles.find((file) => file.path === selectedKnowledgePath) ?? knowledgeFiles[0];
  const waitingTasks = tasks.filter((task) => task.status === 'waiting' && task.continuation);
  const waitingTask = waitingTasks.find((task) => task.taskId === selectedContinuationTaskId)
    ?? waitingTasks[0];
  const visibleEvents = selectedTaskId
    ? events.filter((event) => event.taskId === selectedTaskId)
    : events;
  const visibleDispatches = useMemo(
    () => [...dispatches].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt)),
    [dispatches],
  );
  const groupedTasks = useMemo(
    () => statusOrder.map((status) => ({ status, tasks: tasks.filter((task) => task.status === status) })),
    [tasks],
  );

  useEffect(() => {
    const abort = new AbortController();
    let historySequence = 0;
    const headers = new Headers();
    if (studioHttpToken) headers.set('Authorization', `Bearer ${studioHttpToken}`);

    const refresh = async () => {
      const [snapshotResponse, historyResponse, petsResponse, dispatchesResponse] = await Promise.all([
        fetch(`${studioHttpUrl}/kanban`, { headers, signal: abort.signal }),
        fetch(`${studioHttpUrl}/kanban/events?after=${historySequence.toString()}`, {
          headers,
          signal: abort.signal,
        }),
        fetch(`${studioHttpUrl}/pets`, { headers, signal: abort.signal }),
        fetch(`${studioHttpUrl}/dispatches`, { headers, signal: abort.signal }),
      ]);
      if (!snapshotResponse.ok || !historyResponse.ok || !petsResponse.ok || !dispatchesResponse.ok) {
        throw new Error(
          `Console HTTP request failed (${snapshotResponse.status.toString()}/${historyResponse.status.toString()}/${petsResponse.status.toString()}/${dispatchesResponse.status.toString()}).`,
        );
      }
      const snapshot = await snapshotResponse.json() as KanbanSnapshot;
      const history = await historyResponse.json() as { events: KanbanHistoryEvent[] };
      const petSnapshot = await petsResponse.json() as StudioPetsSnapshot;
      const dispatchSnapshot = await dispatchesResponse.json() as DispatchesSnapshot;
      setTasks(snapshot.tasks);
      setPets(petSnapshot.pets);
      setDispatches(dispatchSnapshot.dispatches);
      setDispatchTarget((current) => current || petSnapshot.pets[0]?.petId || '');
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
              const dispatchItem = event.type === 'dispatch.updated'
                ? event.payload?.dispatch
                : undefined;
              if (isDispatchItem(dispatchItem)) {
                setDispatches((current) => {
                  const next = current.filter(({ invocationId }) => invocationId !== dispatchItem.invocationId);
                  return [...next, dispatchItem];
                });
              }
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
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (studioHttpToken) headers.set('Authorization', `Bearer ${studioHttpToken}`);
    const response = await fetch(`${studioHttpUrl}/dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ petId, input }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? `Studio dispatch failed (${response.status.toString()}).`);
    }
    const receipt = await response.json() as {
      petId: string;
      threadId: string;
      invocationId: string;
    };
    const submittedAt = new Date().toISOString();
    setDispatches((current) => current.some(({ invocationId }) => invocationId === receipt.invocationId)
      ? current
      : [...current, {
          ...receipt,
          input: input.kind === 'resume' && typeof input.continuationId === 'string'
            ? { kind: 'resume' as const, continuationId: input.continuationId }
            : { kind: 'request' as const, request: typeof input.request === 'string' ? input.request : '' },
          status: 'queued',
          submittedAt,
          updatedAt: submittedAt,
        }]);
  }

  async function resumeContinuation(): Promise<void> {
    if (!waitingTask?.continuation) return;
    let payload: unknown;
    try {
      payload = JSON.parse(resumePayload) as unknown;
    } catch {
      setNotice('Resume payload must be valid JSON.');
      return;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      setNotice('Resume payload must be a JSON object.');
      return;
    }
    try {
      await dispatch({
        kind: 'resume',
        continuationId: waitingTask.continuation.continuationId,
        payload,
      }, waitingTask.assigneeId);
      setNotice(`Resume accepted for ${waitingTask.taskId}.`);
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
                  {group.tasks.length > 0 && (
                    <div className="task-list">
                      {group.tasks.map((task) => (
                        <button
                          className={`task-row ${selectedTaskId === task.taskId ? 'selected' : ''}`}
                          key={task.taskId}
                          onClick={() => {
                            setSelectedTaskId((current) => current === task.taskId ? undefined : task.taskId);
                            if (task.status === 'waiting' && task.continuation) {
                              setSelectedContinuationTaskId(task.taskId);
                            }
                          }}
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
          <section className={`authorization panel ${waitingTask ? '' : 'empty'}`}>
            <div className="authorization-label">CONTINUATION</div>
            {waitingTask ? (
              <>
                <div className="authorization-copy">
                  <span className="status-dot status-waiting" />
                  <div>
                    <strong>{waitingTask.taskId} · {waitingTask.brief}</strong>
                    <p>{waitingTask.note ?? 'Pet is waiting for a continuation input.'}</p>
                  </div>
                </div>
                <div className="authorization-actions">
                  {waitingTasks.length > 1 && (
                    <select
                      aria-label="Waiting continuation"
                      onChange={(event) => setSelectedContinuationTaskId(event.target.value)}
                      value={waitingTask.taskId}
                    >
                      {waitingTasks.map((task) => (
                        <option key={task.taskId} value={task.taskId}>
                          {task.taskId} · {task.assigneeId}
                        </option>
                      ))}
                    </select>
                  )}
                  <textarea
                    aria-label="Opaque continuation payload"
                    onChange={(event) => setResumePayload(event.target.value)}
                    value={resumePayload}
                  />
                  <button className="approve-button" onClick={() => void resumeContinuation()} type="button">RESUME</button>
                </div>
              </>
            ) : (
              <p>No Pet continuation is waiting.</p>
            )}
          </section>

          <section className="dispatches panel">
            <div className="panel-heading">
              <span>DISPATCH QUEUE</span>
              <span className="count">{visibleDispatches.length}</span>
            </div>
            <div className="dispatch-columns" aria-hidden="true">
              <span>TIME</span><span>PET</span><span>STATUS</span><span>GOAL</span><span>INVOCATION</span>
            </div>
            <div className="dispatch-list">
              {visibleDispatches.map((item) => (
                <div className="dispatch-row" key={item.invocationId} title={item.error ?? item.output ?? dispatchSummary(item)}>
                  <time>{new Date(item.submittedAt).toLocaleTimeString()}</time>
                  <span className="dispatch-pet">{item.petId}</span>
                  <span className={`dispatch-status dispatch-status-${item.status}`}>
                    <span className="status-dot" />{item.status}
                  </span>
                  <span className="dispatch-goal">{dispatchSummary(item)}</span>
                  <span className="dispatch-id">{item.invocationId.slice(0, 8)}</span>
                </div>
              ))}
              {visibleDispatches.length === 0 && <p className="empty-dispatches">No HTTP dispatches yet.</p>}
            </div>
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
        <select id="dispatch-target" onChange={(event) => setDispatchTarget(event.target.value)} value={dispatchTarget}>
          <option value="">Select Pet</option>
          {pets.map((pet) => (
            <option disabled={pet.startupMode === 'disabled'} key={pet.petId} value={pet.petId}>
              {pet.name} · {pet.petId} · {pet.status}
            </option>
          ))}
        </select>
        <input aria-label="Dispatch goal" onChange={(event) => setDispatchGoal(event.target.value)} placeholder="Describe the next goal…" value={dispatchGoal} />
        <button type="submit">SEND</button>
      </form>
    </main>
  );
}
