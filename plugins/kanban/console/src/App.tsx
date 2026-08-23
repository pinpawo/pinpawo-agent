import { FormEvent, useMemo, useState } from 'react';

type TaskStatus = 'waiting' | 'doing' | 'todo' | 'blocked' | 'done';

type Task = {
  id: string;
  assignee: string;
  title: string;
  status: TaskStatus;
  summary: string;
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

type KnowledgeFile = {
  path: string;
  title: string;
  preview: string;
};

const statusOrder: TaskStatus[] = ['waiting', 'doing', 'todo', 'blocked', 'done'];

const initialTasks: Task[] = [
  {
    id: 'task-024',
    assignee: 'research-pet',
    title: 'Review the source shortlist',
    status: 'waiting',
    summary: 'Needs approval before external research begins',
  },
  {
    id: 'task-023',
    assignee: 'writer-pet',
    title: 'Draft the project brief',
    status: 'doing',
    summary: 'Depends on the source shortlist',
  },
  {
    id: 'task-022',
    assignee: 'planner-pet',
    title: 'Prepare launch milestones',
    status: 'todo',
    summary: 'Ready after the project brief',
  },
  {
    id: 'task-018',
    assignee: 'ops-pet',
    title: 'Validate workspace access',
    status: 'blocked',
    summary: 'Workspace credential is unavailable',
  },
  {
    id: 'task-017',
    assignee: 'planner-pet',
    title: 'Create the initial work plan',
    status: 'done',
    summary: 'Completed 14:02',
  },
];

const initialEvents: EventItem[] = [
  {
    id: 'evt-001',
    time: '14:18:42',
    source: 'studio',
    type: 'dispatch.accepted',
    message: 'Goal accepted by the planning runner',
    detail: 'The browser has only received acknowledgement. Execution remains owned by the runner.',
  },
  {
    id: 'evt-002',
    time: '14:18:43',
    source: 'kanban',
    type: 'task.created',
    taskId: 'task-024',
    message: 'Review the source shortlist',
  },
  {
    id: 'evt-003',
    time: '14:18:44',
    source: 'kanban',
    type: 'task.waiting',
    taskId: 'task-024',
    message: 'Waiting for human authorization',
    detail: 'Requested action: permit the research runner to use the configured external source adapter.',
  },
  {
    id: 'evt-004',
    time: '14:18:55',
    source: 'writer-pet',
    type: 'task.claimed',
    taskId: 'task-023',
    message: 'Drafting project brief',
  },
  {
    id: 'evt-005',
    time: '14:19:07',
    source: 'ops-pet',
    type: 'task.blocked',
    taskId: 'task-018',
    message: 'Workspace credential is unavailable',
    detail: 'This is a static demo. A live Console would receive the persisted block reason from Kanban.',
  },
];

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

function nextTaskId(tasks: Task[]): string {
  const largest = tasks.reduce((current, task) => Math.max(current, Number(task.id.slice(5))), 24);
  return `task-${String(largest + 1).padStart(3, '0')}`;
}

export function App() {
  const [tasks, setTasks] = useState(initialTasks);
  const [events, setEvents] = useState(initialEvents);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [selectedKnowledgePath, setSelectedKnowledgePath] = useState(knowledgeFiles[0].path);
  const [dispatchTarget, setDispatchTarget] = useState('planner-pet');
  const [dispatchGoal, setDispatchGoal] = useState('');
  const [notice, setNotice] = useState('Static prototype · no runtime connection');

  const selectedKnowledge = knowledgeFiles.find((file) => file.path === selectedKnowledgePath) ?? knowledgeFiles[0];
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const waitingTask = tasks.find((task) => task.status === 'waiting');
  const visibleEvents = selectedTaskId
    ? events.filter((event) => event.taskId === selectedTaskId)
    : events;
  const groupedTasks = useMemo(
    () => statusOrder.map((status) => ({ status, tasks: tasks.filter((task) => task.status === status) })),
    [tasks],
  );

  function appendEvent(event: EventItem) {
    setEvents((current) => [...current, event]);
  }

  function resolveAuthorization(decision: 'approved' | 'rejected') {
    if (!waitingTask) {
      return;
    }

    const nextStatus: TaskStatus = decision === 'approved' ? 'doing' : 'blocked';
    setTasks((current) => current.map((task) => task.id === waitingTask.id ? { ...task, status: nextStatus } : task));
    appendEvent({
      id: `evt-${String(events.length + 1).padStart(3, '0')}`,
      time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()),
      source: 'console-demo',
      type: `authorization.${decision}`,
      taskId: waitingTask.id,
      message: decision === 'approved' ? 'Authorization approved in the static prototype' : 'Authorization rejected in the static prototype',
      detail: 'This updates in-memory demo data only. A connected Console will call an interaction adapter instead.',
    });
    setNotice(`Static authorization ${decision}; no checkpoint was resumed.`);
  }

  function submitDispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const goal = dispatchGoal.trim();
    if (!goal) {
      setNotice('Enter a goal before sending the static dispatch.');
      return;
    }

    const id = nextTaskId(tasks);
    setTasks((current) => [...current, {
      id,
      assignee: dispatchTarget,
      title: goal,
      status: 'todo',
      summary: 'Created locally by the static dispatch composer',
    }]);
    appendEvent({
      id: `evt-${String(events.length + 1).padStart(3, '0')}`,
      time: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()),
      source: 'console-demo',
      type: 'dispatch.preview',
      taskId: id,
      message: `Static dispatch prepared for ${dispatchTarget}`,
      detail: 'This demo creates only local state. The future dispatch adapter will submit the goal to its configured host.',
    });
    setSelectedTaskId(undefined);
    setDispatchGoal('');
    setNotice(`Created ${id} in local prototype state.`);
  }

  return (
    <main className="console-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <span>kanban console</span>
          <span className="separator">/</span>
          <span className="instance-name">local prototype</span>
        </div>
        <div className="connection-state" title={notice}>
          <span className="connection-dot" />
          STATIC DATA
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
                          className={`task-row ${selectedTaskId === task.id ? 'selected' : ''}`}
                          key={task.id}
                          onClick={() => setSelectedTaskId((current) => current === task.id ? undefined : task.id)}
                          title={task.summary}
                          type="button"
                        >
                          <span className={`status-dot status-${task.status}`} />
                          <span className="task-id">{task.id}</span>
                          <span className="task-copy">
                            <strong>{task.title}</strong>
                            <small>{task.assignee} · {task.summary}</small>
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
            <div className="authorization-label">AUTHORIZATION</div>
            {waitingTask ? (
              <>
                <div className="authorization-copy">
                  <span className="status-dot status-waiting" />
                  <div>
                    <strong>{waitingTask.id} · {waitingTask.title}</strong>
                    <p>{waitingTask.summary}</p>
                  </div>
                </div>
                <div className="authorization-actions">
                  <button className="quiet-button" onClick={() => setNotice('Static detail: this will be supplied by the interaction adapter.')} type="button">DETAILS</button>
                  <button className="reject-button" onClick={() => resolveAuthorization('rejected')} type="button">REJECT</button>
                  <button className="approve-button" onClick={() => resolveAuthorization('approved')} type="button">APPROVE</button>
                </div>
              </>
            ) : (
              <p>No authorization action is waiting.</p>
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
        <select id="dispatch-target" onChange={(event) => setDispatchTarget(event.target.value)} value={dispatchTarget}>
          <option>planner-pet</option>
          <option>research-pet</option>
          <option>writer-pet</option>
        </select>
        <input aria-label="Dispatch goal" onChange={(event) => setDispatchGoal(event.target.value)} placeholder="Describe the next goal…" value={dispatchGoal} />
        <button type="submit">SEND</button>
      </form>
    </main>
  );
}
