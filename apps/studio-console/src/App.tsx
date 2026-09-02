import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Page = 'studio' | 'kanban' | 'scheduler' | 'notice' | 'trigger' | 'knowledge';
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
type Pet = { petId: string; name: string; role?: string | null; serviceSummary?: string | null };
type Task = {
  taskId: string; assigneeId?: string; title: string; detail: string;
  status: 'assigned' | 'waiting' | 'doing' | 'todo' | 'blocked' | 'done';
  deps: string[]; note?: string; createdAt: string; updatedAt: string;
};
type KanbanSnapshot = { tasks: Task[]; };
type Schedule = {
  scheduleId: string; petId: string; request: string; runAt: string;
  status: 'scheduled' | 'dispatching' | 'dispatched' | 'failed' | 'cancelled'; note?: string;
};
type Notice = {
  noticeId: string;
  ruleId: string;
  level: 'info' | 'warning' | 'error';
  title: string;
  source: string;
  eventType: string;
  payload?: unknown;
  occurredAt: string;
};
type TriggerDefinition = {
  triggerId: string;
  target: { kind: 'pet'; petId: string } | { kind: 'event_payload'; path: string; allowedPetIds?: string[] };
  request: string | { template: string; context?: string[] };
  source: {
    kind: string;
    eventSource?: string;
    type?: string;
    typePrefix?: string;
    event?: string;
    action?: string;
  };
};
type Delivery = {
  deliveryId: string; triggerId: string; idempotencyKey: string;
  status: 'dispatching' | 'accepted' | 'failed'; note?: string; occurredAt: string;
};
type HistoryEvent = {
  sequence: number; eventType: string; occurredAt: string; note?: string;
  taskId?: string; scheduleId?: string; deliveryId?: string; triggerId?: string; status?: string;
};
type LiveEvent = { type: string; source: string; occurredAt: string; payload?: unknown };
type DispatchState = 'queued' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';
type DispatchRecord = {
  invocationId: string;
  petId: string;
  request: string;
  producer: string;
  state: DispatchState;
  updatedAt: string;
  source: 'admission_receipt' | 'lifecycle';
  error?: string;
};
type ProjectDocumentSummary = {
  path: string; title: string; size: number; modifiedAt: string;
};
type ProjectDocument = ProjectDocumentSummary & { content: string };

type Resource<T> = { value: T | null; unavailable: boolean; error?: string };
const empty = <T,>(): Resource<T> => ({ value: null, unavailable: false });

function eventMessage(event: LiveEvent): string {
  if (!event.payload || typeof event.payload !== 'object') return event.type;
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.message === 'string'
    ? payload.message
    : typeof payload.note === 'string' ? payload.note : event.type;
}

function triggerSourceLabel(source: TriggerDefinition['source']): string {
  if (source.kind === 'studio_event') {
    return `${source.eventSource}:${source.type ?? source.typePrefix ?? '*'}`;
  }
  if (source.kind === 'github') {
    return `github:${source.event ?? '*'}${source.action ? `/${source.action}` : ''}`;
  }
  return source.kind;
}

function triggerRequestLabel(request: TriggerDefinition['request']): string {
  return typeof request === 'string' ? request : request.template;
}

function noticeDetail(notice: Notice): string {
  if (!notice.payload || typeof notice.payload !== 'object' || Array.isArray(notice.payload)) {
    return `${notice.source}:${notice.eventType}`;
  }
  const queues = (notice.payload as Record<string, unknown>).queues;
  if (!Array.isArray(queues)) return `${notice.source}:${notice.eventType}`;
  const labels = queues.flatMap((queue) => {
    if (!queue || typeof queue !== 'object' || Array.isArray(queue)) return [];
    const value = queue as Record<string, unknown>;
    return typeof value.petId === 'string' && typeof value.state === 'string'
      ? [`${value.petId} · ${value.state}`]
      : [];
  });
  return labels.length > 0 ? labels.join(', ') : `${notice.source}:${notice.eventType}`;
}

function connectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/\/pets failed \(401\)/.test(message)) {
    return 'Authentication failed. Check the Studio bearer token.';
  }
  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(message)) {
    return 'Studio Host is unreachable. Check the URL and confirm the Host is running.';
  }
  return message;
}

function dispatchRecordFromEvent(event: LiveEvent): DispatchRecord | null {
  const source = event.source === 'studio' && event.type === 'dispatch.accepted'
    ? 'admission_receipt'
    : event.source === 'resident-pet' && /^dispatch\.(queued|running|waiting|completed|interrupted|failed)$/.test(event.type)
      ? 'lifecycle'
      : null;
  const state = source === 'admission_receipt'
    ? 'queued'
    : source === 'lifecycle'
      ? event.type.slice('dispatch.'.length) as DispatchState
      : null;
  if (!source || !state
    || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.invocationId !== 'string' || typeof payload.petId !== 'string'
    || typeof payload.request !== 'string') {
    return null;
  }
  return {
    invocationId: payload.invocationId,
    petId: payload.petId,
    request: payload.request,
    producer: typeof payload.producer === 'string' ? payload.producer : 'resident-pet',
    state,
    updatedAt: event.occurredAt,
    source,
    ...(typeof payload.error === 'string' && payload.error.trim()
      ? { error: payload.error }
      : {}),
  };
}

function appendDispatchRecord(records: DispatchRecord[], record: DispatchRecord): DispatchRecord[] {
  const existingIndex = records.findIndex(({ invocationId }) => invocationId === record.invocationId);
  if (existingIndex < 0) return [...records.slice(-199), record];
  const existing = records[existingIndex];
  if (!existing) return records;
  // Studio's receipt can arrive after the resident runtime has already emitted
  // running or terminal lifecycle. It only establishes the initial queued row;
  // merge its source attribution without regressing the execution observation.
  if (record.source === 'admission_receipt' && existing.state !== 'queued') {
    const next = [...records];
    next[existingIndex] = {
      ...existing,
      producer: record.producer,
    };
    return next;
  }
  const next = [...records];
  next[existingIndex] = {
    ...existing,
    ...record,
    producer: record.source === 'lifecycle' ? existing.producer : record.producer,
  };
  return next;
}

function canRetryDispatch(dispatch: DispatchRecord): boolean {
  return dispatch.producer === 'http' || dispatch.producer === 'studio';
}

export function App() {
  const [page, setPage] = useState<Page>('studio');
  const [baseUrl, setBaseUrl] = useState(() => sessionStorage.getItem('studio.url') ?? 'http://127.0.0.1:3211');
  const [token, setToken] = useState(() => sessionStorage.getItem('studio.token') ?? '');
  const [connectionKey, setConnectionKey] = useState(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('Enter the Studio HTTP token, then connect.');
  const [pets, setPets] = useState<Pet[]>([]);
  const [tasks, setTasks] = useState<Resource<Task[]>>(empty);
  const [schedules, setSchedules] = useState<Resource<Schedule[]>>(empty);
  const [notices, setNotices] = useState<Resource<Notice[]>>(empty);
  const [triggers, setTriggers] = useState<Resource<{ triggers: TriggerDefinition[]; deliveries: Delivery[] }>>(empty);
  const [knowledge, setKnowledge] = useState<Resource<ProjectDocumentSummary[]>>(empty);
  const [selectedDocument, setSelectedDocument] = useState<ProjectDocument | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [assigningTaskId, setAssigningTaskId] = useState('');
  const [kanbanHistory, setKanbanHistory] = useState<HistoryEvent[]>([]);
  const [schedulerHistory, setSchedulerHistory] = useState<HistoryEvent[]>([]);
  const [triggerHistory, setTriggerHistory] = useState<HistoryEvent[]>([]);
  const [dispatchPet, setDispatchPet] = useState('');
  const [dispatchGoal, setDispatchGoal] = useState('');
  const [dispatchSubmitting, setDispatchSubmitting] = useState(false);
  const dispatchSubmittingRef = useRef(false);
  const [retryingInvocationId, setRetryingInvocationId] = useState('');
  const [retryingDeliveryId, setRetryingDeliveryId] = useState('');
  const [schedulePet, setSchedulePet] = useState('');
  const [scheduleRequest, setScheduleRequest] = useState('');
  const [scheduleRunAt, setScheduleRunAt] = useState('');

  const normalizedUrl = useMemo(() => baseUrl.trim().replace(/\/$/, ''), [baseUrl]);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const taskAssignmentTargets = useMemo(() => {
    const routingRules = triggers.value?.triggers.filter((trigger) => (
      trigger.source.kind === 'studio_event'
      && trigger.source.eventSource === 'kanban'
      && trigger.source.type === 'task.assigned'
      && trigger.target.kind === 'event_payload'
      && trigger.target.path === 'payload.assigneeId'
    )) ?? [];
    return pets.filter(({ petId }) => routingRules.some((rule) => (
      rule.target.kind === 'event_payload'
      && (rule.target.allowedPetIds === undefined || rule.target.allowedPetIds.includes(petId))
    )));
  }, [pets, triggers.value]);

  useEffect(() => {
    if (!token || connectionKey === 0) return undefined;
    const abort = new AbortController();
    const read = async <T,>(path: string): Promise<Resource<T>> => {
      const response = await fetch(`${normalizedUrl}${path}`, { headers, signal: abort.signal });
      if (response.status === 404) return { value: null, unavailable: true };
      if (!response.ok) throw new Error(`${path} failed (${response.status.toString()}).`);
      return { value: await response.json() as T, unavailable: false };
    };
    const refresh = async () => {
      const petResponse = await read<{ pets: Pet[] }>('/pets');
      const [kanban, scheduler, notice, trigger, projectFiles, kanbanEvents, schedulerEvents, triggerEvents] = await Promise.all([
        read<KanbanSnapshot>('/kanban').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ schedules: Schedule[] }>('/scheduler').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ notices: Notice[] }>('/notices').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ triggers: TriggerDefinition[]; deliveries: Delivery[] }>('/triggers').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ documents: ProjectDocumentSummary[] }>('/knowledge').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ events: HistoryEvent[] }>('/kanban/events').catch(() => ({ value: null, unavailable: true })),
        read<{ events: HistoryEvent[] }>('/scheduler/events').catch(() => ({ value: null, unavailable: true })),
        read<{ events: HistoryEvent[] }>('/triggers/events').catch(() => ({ value: null, unavailable: true })),
      ]);
      const nextPets = petResponse.value?.pets ?? [];
      setPets(nextPets);
      setDispatchPet((current) => current || nextPets[0]?.petId || '');
      setSchedulePet((current) => current || nextPets[0]?.petId || '');
      setTasks({ ...kanban, value: kanban.value?.tasks ?? null });
      setSchedules({ ...scheduler, value: scheduler.value?.schedules ?? null });
      setNotices({ ...notice, value: notice.value?.notices ?? null });
      setTriggers(trigger);
      setKnowledge({ ...projectFiles, value: projectFiles.value?.documents ?? null });
      setSelectedDocument((current) => (
        current && projectFiles.value?.documents.some(({ path }) => path === current.path)
          ? current
          : null
      ));
      setKanbanHistory(kanbanEvents.value?.events ?? []);
      setSchedulerHistory(schedulerEvents.value?.events ?? []);
      setTriggerHistory(triggerEvents.value?.events ?? []);
      setConnectionState('connected');
      setConnectionError('');
      setNotice('Connected.');
    };
    const run = async () => {
      try {
        await refresh();
        while (!abort.signal.aborted) {
          const response = await fetch(`${normalizedUrl}/events`, { headers, signal: abort.signal });
          if (!response.ok || !response.body) throw new Error(`SSE failed (${response.status.toString()}).`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let pending = '';
          while (!abort.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('SSE connection closed.');
            pending += decoder.decode(chunk.value, { stream: true });
            let boundary = pending.indexOf('\n\n');
            while (boundary >= 0) {
              const block = pending.slice(0, boundary);
              pending = pending.slice(boundary + 2);
              const data = block.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
              if (data) {
                const event = JSON.parse(data) as LiveEvent;
                setEvents((current) => [...current.slice(-499), event]);
                const dispatchRecord = dispatchRecordFromEvent(event);
                if (dispatchRecord) {
                  setDispatches((current) => appendDispatchRecord(current, dispatchRecord));
                }
                if (event.source === 'kanban' || event.source === 'scheduler'
                  || event.source === 'notice' || event.source === 'trigger') {
                  await refresh();
                }
              }
              boundary = pending.indexOf('\n\n');
            }
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          const message = connectionErrorMessage(error);
          setConnectionState('error');
          setConnectionError(message);
          setNotice(message);
        }
      }
    };
    void run();
    return () => abort.abort();
  }, [connectionKey, headers, normalizedUrl, token]);

  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) {
      setConnectionState('error');
      setConnectionError('Enter the Studio bearer token before connecting.');
      setNotice('Enter the Studio bearer token before connecting.');
      return;
    }
    try {
      const parsed = new URL(normalizedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    } catch {
      setConnectionState('error');
      setConnectionError('Enter a valid HTTP(S) Studio URL.');
      setNotice('Enter a valid HTTP(S) Studio URL.');
      return;
    }
    sessionStorage.setItem('studio.url', normalizedUrl);
    sessionStorage.setItem('studio.token', token);
    setEvents([]);
    setDispatches([]);
    setConnectionState('connecting');
    setConnectionError('');
    setConnectionKey((current) => current + 1);
    setNotice('Connecting…');
  };

  const post = async <T = unknown,>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${normalizedUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => null) as ({ error?: string } & T) | null;
    if (!response.ok) throw new Error(value?.error ?? `${path} failed (${response.status.toString()}).`);
    setConnectionKey((current) => current + 1);
    return value as T;
  };

  const openDocument = async (documentPath: string) => {
    try {
      const response = await fetch(
        `${normalizedUrl}/knowledge/document?path=${encodeURIComponent(documentPath)}`,
        { headers },
      );
      const value = await response.json().catch(() => null) as {
        document?: ProjectDocument;
        error?: string;
      } | null;
      if (!response.ok || !value?.document) {
        throw new Error(value?.error ?? `Knowledge document failed (${response.status.toString()}).`);
      }
      setSelectedDocument(value.document);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const reloadKnowledge = async () => {
    try {
      const response = await fetch(`${normalizedUrl}/knowledge`, { headers });
      if (response.status === 404) {
        setKnowledge({ value: null, unavailable: true });
        setSelectedDocument(null);
        return;
      }
      const value = await response.json().catch(() => null) as {
        documents?: ProjectDocumentSummary[];
        error?: string;
      } | null;
      if (!response.ok || !value?.documents) {
        throw new Error(value?.error ?? `Knowledge refresh failed (${response.status.toString()}).`);
      }
      setKnowledge({ value: value.documents, unavailable: false });
      if (selectedDocument?.path
        && value.documents.some(({ path }) => path === selectedDocument.path)) {
        await openDocument(selectedDocument.path);
      } else {
        setSelectedDocument(null);
      }
      setNotice('Knowledge refreshed.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const submitSchedule = (event: FormEvent) => {
    event.preventDefault();
    try {
      const runAt = new Date(scheduleRunAt);
      if (!schedulePet || !scheduleRequest.trim() || !Number.isFinite(runAt.getTime())) {
        throw new Error('Schedule requires a Pet, goal, and valid time.');
      }
      void post('/scheduler', {
        petId: schedulePet,
        request: scheduleRequest,
        runAt: runAt.toISOString(),
      }).then(() => {
        setScheduleRequest('');
        setScheduleRunAt('');
      }).catch((error) => setNotice(String(error)));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const submitDispatch = (event: FormEvent) => {
    event.preventDefault();
    if (dispatchSubmittingRef.current) return;
    const request = dispatchGoal.trim();
    if (!dispatchPet || !request) {
      setNotice('Dispatch requires a Pet and a goal.');
      return;
    }
    dispatchSubmittingRef.current = true;
    setDispatchSubmitting(true);
    void post<{ petId: string; invocationId: string }>('/dispatch', {
      petId: dispatchPet,
      request,
    }).then((receipt) => {
      setDispatchGoal('');
      setDispatches((current) => appendDispatchRecord(current, {
        invocationId: receipt.invocationId,
        petId: receipt.petId,
        request,
        producer: 'http',
        state: 'queued',
        updatedAt: new Date().toISOString(),
        source: 'admission_receipt',
      }));
      setNotice(`Dispatch accepted for ${receipt.petId}.`);
    }).catch((error) => setNotice(connectionErrorMessage(error))).finally(() => {
      dispatchSubmittingRef.current = false;
      setDispatchSubmitting(false);
    });
  };

  const submitDispatchOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const retryDispatch = (dispatch: DispatchRecord) => {
    if (!canRetryDispatch(dispatch)) return;
    setRetryingInvocationId(dispatch.invocationId);
    void post<{ petId: string; invocationId: string }>('/dispatch', {
      petId: dispatch.petId,
      request: dispatch.request,
    }).then((receipt) => {
      setDispatches((current) => appendDispatchRecord(current, {
        invocationId: receipt.invocationId,
        petId: receipt.petId,
        request: dispatch.request,
        producer: 'http',
        state: 'queued',
        updatedAt: new Date().toISOString(),
        source: 'admission_receipt',
      }));
      setNotice(`Retry accepted for ${receipt.petId}.`);
    }).catch((error) => setNotice(connectionErrorMessage(error))).finally(() => {
      setRetryingInvocationId('');
    });
  };

  const assignTask = (taskId: string, assigneeId: string) => {
    setAssigningTaskId(taskId);
    void post('/kanban/control', { action: 'assign', taskId, assigneeId }).then(() => {
      setNotice(`Kanban task ${taskId} was assigned to ${assigneeId}.`);
    }).catch((error) => {
      setNotice(connectionErrorMessage(error));
    }).finally(() => setAssigningTaskId(''));
  };

  const retryTriggerDelivery = (deliveryId: string) => {
    setRetryingDeliveryId(deliveryId);
    void post('/triggers/control', { action: 'retry', deliveryId }).then(() => {
      setNotice(`Trigger delivery ${deliveryId} was retried.`);
    }).catch((error) => {
      setNotice(connectionErrorMessage(error));
    }).finally(() => setRetryingDeliveryId(''));
  };

  const unavailable = (resource: Resource<unknown>, name: string) => (
    <div className="empty-state">
      <strong>{name} Plugin unavailable</strong>
      <span>{resource.error ?? `The current Studio Host does not expose ${name} APIs.`}</span>
    </div>
  );

  return (
    <main className="shell">
      <header>
        <div className="brand">◎ PINPAWO <span>/ STUDIO CONSOLE</span></div>
        <form className="connection" onSubmit={connect}>
          <input aria-label="Studio HTTP URL" onChange={(event) => setBaseUrl(event.target.value)} value={baseUrl} />
          <input aria-label="Studio bearer token" onChange={(event) => setToken(event.target.value)} placeholder="Bearer token" type="password" value={token} />
          <button disabled={connectionState === 'connecting'}>
            {connectionState === 'connecting' ? 'CONNECTING…' : 'CONNECT'}
          </button>
          <span className={`connection-state ${connectionState}`} role="status">
            <i />{connectionState}
          </span>
        </form>
      </header>
      <nav>
        {(['studio', 'kanban', 'scheduler', 'notice', 'trigger', 'knowledge'] as const).map((item) => (
          <button className={page === item ? 'active' : ''} key={item} onClick={() => setPage(item)}>{item}</button>
        ))}
      </nav>
      <section className="content">
        {connectionError && <div className="connection-alert" role="alert">
          <strong>CONNECTION FAILED</strong>
          <span>{connectionError}</span>
        </div>}
        {page === 'studio' && <>
          <div className="section-title"><span>RESIDENT PETS</span><b>{pets.length}</b></div>
          <div className="rows">{pets.map((pet) => <div className="row" key={pet.petId}><code>{pet.petId}</code><strong>{pet.name}</strong><span>{pet.role ?? pet.serviceSummary ?? 'resident'}</span></div>)}</div>
          <form className="composer chat-composer" onSubmit={submitDispatch}>
            <label className="composer-target">
              <span>DISPATCH TO</span>
              <select disabled={dispatchSubmitting} onChange={(event) => setDispatchPet(event.target.value)} value={dispatchPet}>{pets.map((pet) => <option key={pet.petId} value={pet.petId}>{pet.petId}</option>)}</select>
            </label>
            <div className="chat-input">
              <label htmlFor="dispatch-goal">MESSAGE</label>
              <textarea
                id="dispatch-goal"
                onChange={(event) => setDispatchGoal(event.target.value)}
                onKeyDown={submitDispatchOnEnter}
                placeholder="Describe the goal for this Pet"
                rows={4}
                value={dispatchGoal}
              />
              <div className="chat-actions">
                <span>Enter to send / Shift+Enter for a new line</span>
                <button disabled={dispatchSubmitting || connectionState !== 'connected' || !dispatchPet || !dispatchGoal.trim()}>
                  {dispatchSubmitting ? 'DISPATCHING…' : 'DISPATCH'}
                </button>
              </div>
            </div>
          </form>
          <div className="section-title"><span>DISPATCH ACTIVITY</span><b>{dispatches.length}</b></div>
          {dispatches.length > 0
            ? <div className="rows dispatch-rows">
              {dispatches.slice().reverse().map((dispatch) => (
                <div className="row dispatch-row" key={dispatch.invocationId}>
                  <time>{new Date(dispatch.updatedAt).toLocaleTimeString()}</time>
                  <em className={dispatch.state}>{dispatch.state}</em>
                  <strong>{dispatch.request}</strong>
                  <span>
                    {dispatch.petId} · {dispatch.error ?? `${dispatch.producer} · ${dispatch.invocationId.slice(0, 8)}`}
                    {dispatch.state === 'failed' && canRetryDispatch(dispatch) && <button
                      className="inline-action"
                      disabled={retryingInvocationId === dispatch.invocationId}
                      onClick={() => retryDispatch(dispatch)}
                      type="button"
                    >
                      {retryingInvocationId === dispatch.invocationId ? 'retrying…' : 'retry'}
                    </button>}
                  </span>
                </div>
              ))}
            </div>
            : <div className="compact-empty">No dispatch has been accepted in this Console session.</div>}
          <div className="section-title"><span>LIVE EVENTS</span><b>{events.length}</b></div>
          <div className="rows event-rows">{events.slice().reverse().map((event, index) => <div className="row" key={`${event.occurredAt}-${index.toString()}`}><time>{new Date(event.occurredAt).toLocaleTimeString()}</time><code>{event.source}</code><strong>{event.type}</strong><span>{eventMessage(event)}</span></div>)}</div>
        </>}
        {page === 'kanban' && (tasks.value ? <>
          <div className="section-title"><span>TASK FLOW</span><span><em className="mode-label">manual assignment</em><b>{tasks.value.length}</b></span></div>
          <KanbanFlow
            pets={taskAssignmentTargets}
            onAssign={assignTask}
            assigningTaskId={assigningTaskId}
            tasks={tasks.value}
          />
          <History title="KANBAN HISTORY" events={kanbanHistory} />
        </> : unavailable(tasks, 'Kanban'))}
        {page === 'scheduler' && (schedules.value ? <>
          <div className="section-title"><span>ONE-SHOT SCHEDULES</span><b>{schedules.value.length}</b></div>
          <form className="composer scheduler" onSubmit={submitSchedule}>
            <select onChange={(event) => setSchedulePet(event.target.value)} value={schedulePet}>{pets.map((pet) => <option key={pet.petId} value={pet.petId}>{pet.petId}</option>)}</select>
            <input onChange={(event) => setScheduleRequest(event.target.value)} placeholder="Scheduled goal…" value={scheduleRequest} />
            <input onChange={(event) => setScheduleRunAt(event.target.value)} type="datetime-local" value={scheduleRunAt} />
            <button>SCHEDULE</button>
          </form>
          <div className="rows">{schedules.value.map((schedule) => <div className="row" key={schedule.scheduleId}><em className={schedule.status}>{schedule.status}</em><time>{new Date(schedule.runAt).toLocaleString()}</time><strong>{schedule.request}</strong><span>{schedule.petId}{schedule.note ? ` · ${schedule.note}` : ''}{schedule.status === 'scheduled' && <button className="inline-action" onClick={() => { void post('/scheduler/control', { action: 'cancel', scheduleId: schedule.scheduleId }).catch((error) => setNotice(String(error))); }} type="button">cancel</button>}</span></div>)}</div>
          <History title="SCHEDULER HISTORY" events={schedulerHistory} />
        </> : unavailable(schedules, 'Scheduler'))}
        {page === 'notice' && (notices.value ? <>
          <div className="section-title"><span>NOTICES</span><b>{notices.value.length}</b></div>
          {notices.value.length > 0
            ? <div className="rows">{notices.value.map((item) => <div className="row" key={item.noticeId}>
              <time>{new Date(item.occurredAt).toLocaleString()}</time>
              <em className={item.level}>{item.level}</em>
              <strong>{item.title}</strong>
              <span>{noticeDetail(item)}</span>
            </div>)}</div>
            : <div className="compact-empty">No notices have been recorded.</div>}
        </> : unavailable(notices, 'Notice'))}
        {page === 'trigger' && (triggers.value ? <>
          <div className="section-title"><span>TRIGGERS</span><b>{triggers.value.triggers.length}</b></div>
          <div className="rows">{triggers.value.triggers.map((trigger) => <div className="row" key={trigger.triggerId}><code>{trigger.triggerId}</code><strong>{triggerRequestLabel(trigger.request)}</strong><span>{triggerSourceLabel(trigger.source)} → {trigger.target.kind === 'pet' ? trigger.target.petId : trigger.target.path}</span></div>)}</div>
          <div className="hint">POST /triggers/invoke · Authorization: Trigger &lt;secret&gt; · body: triggerId, idempotencyKey, payload</div>
          <div className="section-title"><span>DELIVERIES</span><b>{triggers.value.deliveries.length}</b></div>
          <div className="rows">{triggers.value.deliveries.map((delivery) => <div className="row" key={delivery.deliveryId}><em className={delivery.status}>{delivery.status}</em><code>{delivery.triggerId}</code><strong>{delivery.idempotencyKey}</strong><span>{delivery.note ?? new Date(delivery.occurredAt).toLocaleString()}{delivery.status === 'failed' && <button className="inline-action" disabled={retryingDeliveryId === delivery.deliveryId} onClick={() => retryTriggerDelivery(delivery.deliveryId)} type="button">{retryingDeliveryId === delivery.deliveryId ? 'retrying…' : 'retry'}</button>}</span></div>)}</div>
          <History title="TRIGGER HISTORY" events={triggerHistory} />
        </> : unavailable(triggers, 'Trigger'))}
        {page === 'knowledge' && (knowledge.value ? <>
          <div className="section-title"><span>PROJECT MARKDOWN</span><span><button className="title-action" onClick={() => { void reloadKnowledge(); }} type="button">REFRESH</button><b>{knowledge.value.length}</b></span></div>
          <div className="knowledge-layout">
            <div className="rows knowledge-files">{knowledge.value.map((document) => (
              <button
                className={selectedDocument?.path === document.path ? 'knowledge-file active' : 'knowledge-file'}
                key={document.path}
                onClick={() => { void openDocument(document.path); }}
                type="button"
              >
                <code>{document.path}</code>
                <span>{new Date(document.modifiedAt).toLocaleString()} · {document.size.toString()} B</span>
              </button>
            ))}</div>
            <article className="knowledge-document">
              {selectedDocument
                ? <><h2>{selectedDocument.path}</h2><pre>{selectedDocument.content}</pre></>
                : <div className="empty-state"><strong>Select a Markdown document</strong><span>Knowledge remains ordinary project files; this view is read-only.</span></div>}
            </article>
          </div>
        </> : unavailable(knowledge, 'Project Files'))}
      </section>
      <footer>{notice}</footer>
    </main>
  );
}

function KanbanFlow({
  pets,
  onAssign,
  assigningTaskId,
  tasks,
}: {
  pets: Pet[];
  onAssign: (taskId: string, assigneeId: string) => void;
  assigningTaskId: string;
  tasks: Task[];
}) {
  const [selectedTargets, setSelectedTargets] = useState<Record<string, string>>({});
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const groups = [
    { id: 'active', label: 'ACTIVE', tasks: tasks.filter(({ status }) => status === 'doing' || status === 'waiting') },
    { id: 'assigned', label: 'ASSIGNED', tasks: tasks.filter(({ status }) => status === 'assigned') },
    { id: 'queue', label: 'QUEUE', tasks: tasks.filter(({ status }) => status === 'todo') },
    { id: 'blocked', label: 'BLOCKED', tasks: tasks.filter(({ status }) => status === 'blocked') },
    { id: 'done', label: 'COMPLETED', tasks: tasks.filter(({ status }) => status === 'done') },
  ];

  if (tasks.length === 0) {
    return <div className="empty-state compact">
      <strong>No Kanban tasks yet</strong>
      <span>The Planner creates tasks through the Kanban Toolkit.</span>
    </div>;
  }

  return <div className="task-flow">
    <div className="flow-summary">
      <span>{pets.length > 0
        ? 'Planner records tasks. Select a Pet for a ready task; the Trigger rule then delivers it and records the outcome.'
        : 'No Trigger rule currently exposes an eligible task destination.'}</span>
    </div>
    {groups.map((group) => group.tasks.length > 0 && <section className="task-group" key={group.id}>
      <div className="task-group-title"><span>{group.label}</span><b>{group.tasks.length}</b></div>
      <div className="task-list">{group.tasks.map((task) => {
        const incompleteDependencies = task.deps.filter((dependencyId) => (
          tasksById.get(dependencyId)?.status !== 'done'
        ));
        const assignable = task.status === 'todo' && incompleteDependencies.length === 0;
        const assigning = assigningTaskId === task.taskId;
        const visibleStatus = task.status === 'todo' && incompleteDependencies.length > 0
          ? 'waiting deps'
          : task.status;
        return <details className="task-card" key={task.taskId}>
          <summary className="task-summary">
            <div className="task-card-head">
            <em className={task.status}>{visibleStatus}</em>
            <code title={task.taskId}>{task.taskId.slice(0, 8)}</code>
            <span className="task-assignee">→ {task.assigneeId ?? 'unassigned'}</span>
            </div>
            <strong className="task-title">{task.title}</strong>
          </summary>
          <div className="task-expanded">
            <p className="task-detail">{task.detail}</p>
            {task.deps.length > 0 && <div className="task-dependencies">
              <span>DEPENDS ON</span>
              {task.deps.map((dependencyId) => <code
                className={tasksById.get(dependencyId)?.status === 'done' ? 'complete' : ''}
                key={dependencyId}
                title={dependencyId}
              >{dependencyId.slice(0, 8)}</code>)}
            </div>}
            {task.note && <p className="task-note">{task.note}</p>}
            <div className="task-expanded-footer">
              <time>updated {new Date(task.updatedAt).toLocaleString()}</time>
              {task.status === 'todo' && <label className="task-assignment">
                <select aria-label={`Assign ${task.title}`} disabled={!assignable || Boolean(assigningTaskId)} onChange={(event) => setSelectedTargets((current) => ({ ...current, [task.taskId]: event.target.value }))} title={assignable ? undefined : `Waiting for: ${incompleteDependencies.join(', ')}`} value={selectedTargets[task.taskId] ?? ''}>
                  <option disabled value="">{assignable ? 'ASSIGN TO…' : 'WAITING FOR DEPENDENCIES'}</option>
                  {pets.map((pet) => <option key={pet.petId} value={pet.petId}>{pet.name} ({pet.petId})</option>)}
                </select>
                <button className="task-action" disabled={!assignable || !selectedTargets[task.taskId] || Boolean(assigningTaskId)} onClick={() => onAssign(task.taskId, selectedTargets[task.taskId]!)} type="button">ASSIGN</button>
                {assigning && <span>assigning…</span>}
              </label>}
            </div>
          </div>
        </details>;
      })}</div>
    </section>)}
  </div>;
}

function History({ title, events }: { title: string; events: HistoryEvent[] }) {
  return <>
    <div className="section-title"><span>{title}</span><b>{events.length}</b></div>
    <div className="rows event-rows">{events.slice().reverse().map((event) => (
      <div className="row" key={`${title}-${event.sequence.toString()}`}>
        <time>{new Date(event.occurredAt).toLocaleTimeString()}</time>
        <code>#{event.sequence.toString()}</code>
        <strong>{event.eventType}</strong>
        <span>{event.taskId ?? event.scheduleId ?? event.deliveryId ?? event.triggerId ?? event.status ?? event.note ?? '—'}</span>
      </div>
    ))}</div>
  </>;
}
