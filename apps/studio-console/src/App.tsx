import { type FormEvent, useEffect, useMemo, useState } from 'react';

type Page = 'studio' | 'kanban' | 'scheduler' | 'trigger';
type Pet = { petId: string; name: string; role?: string | null; serviceSummary?: string | null };
type Task = {
  taskId: string; assigneeId: string; brief: string;
  status: 'waiting' | 'doing' | 'todo' | 'blocked' | 'done';
  deps: string[]; note?: string;
};
type Schedule = {
  scheduleId: string; petId: string; request: string; runAt: string;
  status: 'scheduled' | 'dispatching' | 'completed' | 'failed' | 'cancelled'; note?: string;
};
type TriggerDefinition = { triggerId: string; petId: string; requestPrefix: string };
type Delivery = {
  deliveryId: string; triggerId: string; idempotencyKey: string;
  status: 'dispatching' | 'accepted' | 'failed'; note?: string; occurredAt: string;
};
type HistoryEvent = {
  sequence: number; eventType: string; occurredAt: string; note?: string;
  taskId?: string; scheduleId?: string; deliveryId?: string; triggerId?: string; status?: string;
};
type LiveEvent = { type: string; source: string; occurredAt: string; payload?: unknown };

type Resource<T> = { value: T | null; unavailable: boolean; error?: string };
const empty = <T,>(): Resource<T> => ({ value: null, unavailable: false });

function eventMessage(event: LiveEvent): string {
  if (!event.payload || typeof event.payload !== 'object') return event.type;
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.message === 'string'
    ? payload.message
    : typeof payload.note === 'string' ? payload.note : event.type;
}

export function App() {
  const [page, setPage] = useState<Page>('studio');
  const [baseUrl, setBaseUrl] = useState(() => sessionStorage.getItem('studio.url') ?? 'http://127.0.0.1:3211');
  const [token, setToken] = useState(() => sessionStorage.getItem('studio.token') ?? '');
  const [connectionKey, setConnectionKey] = useState(0);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState('Enter the Studio HTTP token, then connect.');
  const [pets, setPets] = useState<Pet[]>([]);
  const [tasks, setTasks] = useState<Resource<Task[]>>(empty);
  const [schedules, setSchedules] = useState<Resource<Schedule[]>>(empty);
  const [triggers, setTriggers] = useState<Resource<{ triggers: TriggerDefinition[]; deliveries: Delivery[] }>>(empty);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [kanbanHistory, setKanbanHistory] = useState<HistoryEvent[]>([]);
  const [schedulerHistory, setSchedulerHistory] = useState<HistoryEvent[]>([]);
  const [triggerHistory, setTriggerHistory] = useState<HistoryEvent[]>([]);
  const [dispatchPet, setDispatchPet] = useState('');
  const [dispatchGoal, setDispatchGoal] = useState('');
  const [schedulePet, setSchedulePet] = useState('');
  const [scheduleRequest, setScheduleRequest] = useState('');
  const [scheduleRunAt, setScheduleRunAt] = useState('');

  const normalizedUrl = useMemo(() => baseUrl.trim().replace(/\/$/, ''), [baseUrl]);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

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
      const [kanban, scheduler, trigger, kanbanEvents, schedulerEvents, triggerEvents] = await Promise.all([
        read<{ tasks: Task[] }>('/kanban').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ schedules: Schedule[] }>('/scheduler').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ triggers: TriggerDefinition[]; deliveries: Delivery[] }>('/triggers').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
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
      setTriggers(trigger);
      setKanbanHistory(kanbanEvents.value?.events ?? []);
      setSchedulerHistory(schedulerEvents.value?.events ?? []);
      setTriggerHistory(triggerEvents.value?.events ?? []);
      setConnected(true);
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
                if (event.source === 'kanban' || event.source === 'scheduler' || event.source === 'trigger') {
                  await refresh();
                }
              }
              boundary = pending.indexOf('\n\n');
            }
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
  }, [connectionKey, headers, normalizedUrl, token]);

  const connect = (event: FormEvent) => {
    event.preventDefault();
    sessionStorage.setItem('studio.url', normalizedUrl);
    sessionStorage.setItem('studio.token', token);
    setEvents([]);
    setConnectionKey((current) => current + 1);
    setNotice('Connecting…');
  };

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${normalizedUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(value?.error ?? `${path} failed (${response.status.toString()}).`);
    setConnectionKey((current) => current + 1);
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
          <button>CONNECT</button>
          <i className={connected ? 'online' : ''} />
        </form>
      </header>
      <nav>
        {(['studio', 'kanban', 'scheduler', 'trigger'] as const).map((item) => (
          <button className={page === item ? 'active' : ''} key={item} onClick={() => setPage(item)}>{item}</button>
        ))}
      </nav>
      <section className="content">
        {page === 'studio' && <>
          <div className="section-title"><span>RESIDENT PETS</span><b>{pets.length}</b></div>
          <div className="rows">{pets.map((pet) => <div className="row" key={pet.petId}><code>{pet.petId}</code><strong>{pet.name}</strong><span>{pet.role ?? pet.serviceSummary ?? 'resident'}</span></div>)}</div>
          <form className="composer" onSubmit={(event) => { event.preventDefault(); void post('/dispatch', { petId: dispatchPet, request: dispatchGoal }).then(() => setDispatchGoal('')).catch((error) => setNotice(String(error))); }}>
            <select onChange={(event) => setDispatchPet(event.target.value)} value={dispatchPet}>{pets.map((pet) => <option key={pet.petId} value={pet.petId}>{pet.petId}</option>)}</select>
            <input onChange={(event) => setDispatchGoal(event.target.value)} placeholder="Dispatch a goal…" value={dispatchGoal} />
            <button>DISPATCH</button>
          </form>
          <div className="section-title"><span>LIVE EVENTS</span><b>{events.length}</b></div>
          <div className="rows event-rows">{events.slice().reverse().map((event, index) => <div className="row" key={`${event.occurredAt}-${index.toString()}`}><time>{new Date(event.occurredAt).toLocaleTimeString()}</time><code>{event.source}</code><strong>{event.type}</strong><span>{eventMessage(event)}</span></div>)}</div>
        </>}
        {page === 'kanban' && (tasks.value ? <>
          <div className="section-title"><span>TASK FLOW</span><b>{tasks.value.length}</b></div>
          <div className="rows">{tasks.value.map((task) => <div className="row" key={task.taskId}><em className={task.status}>{task.status}</em><code>{task.taskId}</code><strong>{task.brief}</strong><span>{task.assigneeId}{task.note ? ` · ${task.note}` : ''}</span></div>)}</div>
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
        {page === 'trigger' && (triggers.value ? <>
          <div className="section-title"><span>TRIGGERS</span><b>{triggers.value.triggers.length}</b></div>
          <div className="rows">{triggers.value.triggers.map((trigger) => <div className="row" key={trigger.triggerId}><code>{trigger.triggerId}</code><strong>{trigger.requestPrefix}</strong><span>→ {trigger.petId}</span></div>)}</div>
          <div className="hint">POST /triggers/invoke · Authorization: Trigger &lt;secret&gt; · body: triggerId, idempotencyKey, payload</div>
          <div className="section-title"><span>DELIVERIES</span><b>{triggers.value.deliveries.length}</b></div>
          <div className="rows">{triggers.value.deliveries.map((delivery) => <div className="row" key={delivery.deliveryId}><em className={delivery.status}>{delivery.status}</em><code>{delivery.triggerId}</code><strong>{delivery.idempotencyKey}</strong><span>{delivery.note ?? new Date(delivery.occurredAt).toLocaleString()}</span></div>)}</div>
          <History title="TRIGGER HISTORY" events={triggerHistory} />
        </> : unavailable(triggers, 'Trigger'))}
      </section>
      <footer>{notice}</footer>
    </main>
  );
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
