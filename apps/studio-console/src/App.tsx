import React, {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { appendDispatchRecord, dispatchRecordFromEvent, markObservationLost, type DispatchRecord } from './dispatchActivity';
import { observeStudioEvents } from './studioEvents';
import { ChannelPanel } from './ChannelPanel';
import { KnowledgeDocument } from './KnowledgeDocument';
import { appendChannelDeliveries, type ChannelDelivery, type ChannelRoutingSkip } from './channelData';
import { Bell, BookOpen, CalendarClock, MessagesSquare, Plug, Zap, type LucideIcon } from 'lucide-react';
import logoMark from '../../../assets/brand/pinpawo-primary-white.svg';

type Page = 'channel' | 'scheduler' | 'notice' | 'trigger' | 'knowledge';
const pageItems: { page: Page; label: string; Icon: LucideIcon }[] = [
  { page: 'channel', label: 'Channel', Icon: MessagesSquare },
  { page: 'scheduler', label: 'Scheduler', Icon: CalendarClock },
  { page: 'notice', label: 'Notice', Icon: Bell },
  { page: 'trigger', label: 'Trigger', Icon: Zap },
  { page: 'knowledge', label: 'Knowledge', Icon: BookOpen },
];
type ConnectionState = 'idle' | 'connecting' | 'reconnecting' | 'connected' | 'error';
type Pet = { petId: string; name: string; role?: string | null; serviceSummary?: string | null };
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
  scheduleId?: string; deliveryId?: string; triggerId?: string; status?: string;
};
type ProjectDocumentSummary = {
  path: string; title: string; size: number; modifiedAt: string;
};
type ProjectDocument = ProjectDocumentSummary & { content: string };

type Resource<T> = { value: T | null; unavailable: boolean; error?: string };
const empty = <T,>(): Resource<T> => ({ value: null, unavailable: false });

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

const CLIENT_POLL_MS = 3000;

function connectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/failed \(401\)/.test(message)) {
    return 'Authentication failed. Check the Studio bearer token.';
  }
  if (/Failed to fetch|NetworkError|fetch failed|Load failed/i.test(message)) {
    return 'Studio Host is unreachable. Check the URL and confirm the Host is running.';
  }
  return message;
}

function canRetryDispatch(dispatch: DispatchRecord): boolean {
  return dispatch.producer === 'http' || dispatch.producer === 'studio';
}

export function App() {
  const storedToken = sessionStorage.getItem('studio.token') ?? '';
  const storedUrl = sessionStorage.getItem('studio.url') ?? 'http://127.0.0.1:3211';
  const [page, setPage] = useState<Page>('channel');
  const [baseUrl, setBaseUrl] = useState(storedUrl);
  const [token, setToken] = useState(storedToken);
  const [connectionUrlDraft, setConnectionUrlDraft] = useState(storedUrl);
  const [connectionTokenDraft, setConnectionTokenDraft] = useState(storedToken);
  const [connectionKey, setConnectionKey] = useState(storedToken ? 1 : 0);
  const [connectionState, setConnectionState] = useState<ConnectionState>(storedToken ? 'connecting' : 'idle');
  const [connectionModalOpen, setConnectionModalOpen] = useState(!storedToken);
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState(storedToken ? 'Connecting…' : 'Enter the Studio HTTP token, then connect.');
  const [pets, setPets] = useState<Pet[]>([]);
  // Who the token is; a client key or JWT sees only its Channels.
  const [identity, setIdentity] = useState<{ clientId: string; scope: 'studio' | 'client' } | null>(null);
  const clientMode = identity?.scope === 'client';
  const [petsReady, setPetsReady] = useState(false);
  const [channelVersion, setChannelVersion] = useState(0);
  const [channelDeliveries, setChannelDeliveries] = useState<ChannelDelivery[]>([]);
  const [channelFailures, setChannelFailures] = useState<{ channelId: string; petId?: string; error: string }[]>([]);
  const [routingSkips, setRoutingSkips] = useState<ChannelRoutingSkip[]>([]);
  const [schedules, setSchedules] = useState<Resource<Schedule[]>>(empty);
  const [notices, setNotices] = useState<Resource<Notice[]>>(empty);
  const [triggers, setTriggers] = useState<Resource<{ triggers: TriggerDefinition[]; deliveries: Delivery[] }>>(empty);
  const [knowledge, setKnowledge] = useState<Resource<ProjectDocumentSummary[]>>(empty);
  const [selectedDocument, setSelectedDocument] = useState<ProjectDocument | null>(null);
  const [knowledgeAnchor, setKnowledgeAnchor] = useState('');
  const knowledgeRequest = useRef(0);
  const knowledgeListRequest = useRef(0);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [schedulerHistory, setSchedulerHistory] = useState<HistoryEvent[]>([]);
  const [triggerHistory, setTriggerHistory] = useState<HistoryEvent[]>([]);
  const [dispatchPet, setDispatchPet] = useState('');
  const [dispatchGoal, setDispatchGoal] = useState('');
  const [dispatchDrawerOpen, setDispatchDrawerOpen] = useState(false);
  const [dispatchSubmitting, setDispatchSubmitting] = useState(false);
  const dispatchSubmittingRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const observationEpoch = useRef(0);
  const [retryingInvocationId, setRetryingInvocationId] = useState('');
  const [retryingDeliveryId, setRetryingDeliveryId] = useState('');
  const [schedulePet, setSchedulePet] = useState('');
  const [scheduleRequest, setScheduleRequest] = useState('');
  const [scheduleRunAt, setScheduleRunAt] = useState('');

  const normalizedUrl = useMemo(() => baseUrl.trim().replace(/\/$/, ''), [baseUrl]);
  const activeHost = useRef(normalizedUrl);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  useEffect(() => {
    if (!token || connectionKey === 0) return undefined;
    const abort = new AbortController();
    setPetsReady(false);
    setIdentity(null);
    const read = async <T,>(path: string): Promise<Resource<T>> => {
      const response = await fetch(`${normalizedUrl}${path}`, { headers, signal: abort.signal });
      if (response.status === 404) return { value: null, unavailable: true };
      if (!response.ok) throw new Error(`${path} failed (${response.status.toString()}).`);
      return { value: await response.json() as T, unavailable: false };
    };
    let clientOnly = false;
    const refresh = async () => {
      const petResponse = await read<{ pets: Pet[] }>('/pets');
      if (clientOnly) {
        if (abort.signal.aborted) return;
        const nextPets = petResponse.value?.pets ?? [];
        setPets(nextPets);
        setPetsReady(true);
        return;
      }
      const listRequest = ++knowledgeListRequest.current;
      const [scheduler, notice, trigger, projectFiles, schedulerEvents, triggerEvents] = await Promise.all([
        read<{ schedules: Schedule[] }>('/scheduler').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ notices: Notice[] }>('/notices').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ triggers: TriggerDefinition[]; deliveries: Delivery[] }>('/triggers').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ documents: ProjectDocumentSummary[] }>('/knowledge').catch((error) => ({ value: null, unavailable: false, error: String(error) })),
        read<{ events: HistoryEvent[] }>('/scheduler/events').catch(() => ({ value: null, unavailable: true })),
        read<{ events: HistoryEvent[] }>('/triggers/events').catch(() => ({ value: null, unavailable: true })),
      ]);
      if (abort.signal.aborted) return;
      const nextPets = petResponse.value?.pets ?? [];
      setPets(nextPets);
      setPetsReady(true);
      setDispatchPet((current) => nextPets.some(({ petId }) => petId === current) ? current : nextPets[0]?.petId || '');
      setSchedulePet((current) => nextPets.some(({ petId }) => petId === current) ? current : nextPets[0]?.petId || '');
      setSchedules({ ...scheduler, value: scheduler.value?.schedules ?? null });
      setNotices({ ...notice, value: notice.value?.notices ?? null });
      setTriggers(trigger);
      if (listRequest === knowledgeListRequest.current) {
        setKnowledge({ ...projectFiles, value: projectFiles.value?.documents ?? null });
        setSelectedDocument((current) => (
          current && projectFiles.value?.documents.some(({ path }) => path === current.path)
            ? current
            : null
        ));
      }
      setSchedulerHistory(schedulerEvents.value?.events ?? []);
      setTriggerHistory(triggerEvents.value?.events ?? []);
    };
    // Refreshing domain snapshots must never replace the live observation stream.
    let refreshPending: Promise<void> | undefined;
    let refreshAgain = false;
    const refreshResources = () => {
      refreshAgain = true;
      if (!refreshPending) refreshPending = (async () => {
        while (refreshAgain && !abort.signal.aborted) {
          refreshAgain = false;
          await refresh();
        }
      })().finally(() => { refreshPending = undefined; });
      return refreshPending;
    };
    refreshRef.current = refreshResources;
    const refreshInBackground = () => {
      void refreshResources().catch((error) => {
        if (!abort.signal.aborted) setNotice(connectionErrorMessage(error));
      });
    };
    const observe = () => observeStudioEvents({
      url: `${normalizedUrl}/events`, headers, signal: abort.signal,
      onConnected: () => {
        setConnectionState('connected');
        setConnectionError('');
        setConnectionModalOpen(false);
        setNotice('Connected. Activity missed while disconnected remains unknown.');
        refreshInBackground();
      },
      onDisconnected: (error, retrying) => {
        observationEpoch.current++;
        setDispatches(markObservationLost);
        setConnectionState(retrying ? 'reconnecting' : 'error');
        setConnectionError(connectionErrorMessage(error));
        if (!retrying) setConnectionModalOpen(true);
      },
      onEvent: (event) => {
        const record = dispatchRecordFromEvent(event);
        if (record) setDispatches((current) => appendDispatchRecord(current, record));
        if (['scheduler', 'notice', 'trigger'].includes(event.source)
          || (event.source === 'studio' && event.type.startsWith('pet.'))) refreshInBackground();
        if (event.source === 'channel') {
          setChannelVersion(value => value + 1);
          const payload = event.payload as Partial<ChannelDelivery> & { petId?: string } | undefined;
          if (event.type === 'channel.delivery' && payload?.channelId && payload.state) {
            setChannelDeliveries(current => appendChannelDeliveries(current, [payload as ChannelDelivery]));
          }
          const skip = event.payload as Partial<ChannelRoutingSkip> | undefined;
          if (event.type === 'channel.routing.skipped' && skip?.channelId && skip.messageId && skip.reason) {
            setRoutingSkips(current => [...current.slice(-199), skip as ChannelRoutingSkip]);
          }
          if (event.type === 'channel.message_failed' && payload?.channelId && payload.error) {
            const failure = { channelId: payload.channelId, petId: payload.petId, error: payload.error };
            setChannelFailures(current => [...current.slice(-19), failure]);
          }
        }
      },
    });
    // The event stream is the local token's; a client has none and polls its Channels instead.
    let poll: ReturnType<typeof setInterval> | undefined;
    void read<{ clientId: string; scope: 'studio' | 'client' }>('/me').then((me) => {
      if (abort.signal.aborted) return;
      if (!me.value) throw new Error('/me failed (404).');
      setIdentity(me.value);
      if (me.value.scope === 'studio') return observe();
      clientOnly = true;
      setPage('channel');
      setConnectionState('connected');
      setConnectionError('');
      setConnectionModalOpen(false);
      setNotice(`Connected as ${me.value.clientId}. Channels refresh every few seconds.`);
      refreshInBackground();
      // Each poll checks the token too, so a stopped Host or revoked client shows as disconnected.
      poll = setInterval(() => {
        void read('/me').then(() => {
          if (abort.signal.aborted) return;
          setConnectionState('connected');
          setConnectionError('');
          setChannelVersion(value => value + 1);
          // A client sees no events, so Pets created or renamed meanwhile come with the poll.
          refreshInBackground();
        }).catch((error) => {
          if (abort.signal.aborted) return;
          setConnectionState('reconnecting');
          setConnectionError(connectionErrorMessage(error));
        });
      }, CLIENT_POLL_MS);
    }).catch((error) => {
      if (abort.signal.aborted) return;
      setConnectionState('error');
      setConnectionError(connectionErrorMessage(error));
      setConnectionModalOpen(true);
    });
    return () => {
      abort.abort();
      if (poll) clearInterval(poll);
      refreshRef.current = async () => undefined;
    };
  }, [connectionKey, headers, normalizedUrl, token]);

  const connect = (event: FormEvent) => {
    event.preventDefault();
    if (!connectionTokenDraft.trim()) {
      setConnectionState('error');
      setConnectionError('Enter the Studio bearer token before connecting.');
      setNotice('Enter the Studio bearer token before connecting.');
      return;
    }
    let nextUrl: string;
    try {
      const parsed = new URL(connectionUrlDraft.trim().replace(/\/$/, ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
      nextUrl = parsed.origin;
    } catch {
      setConnectionState('error');
      setConnectionError('Enter a valid HTTP(S) Studio URL.');
      setNotice('Enter a valid HTTP(S) Studio URL.');
      return;
    }
    const nextToken = connectionTokenDraft.trim();
    observationEpoch.current++;
    knowledgeRequest.current++;
    knowledgeListRequest.current++;
    activeHost.current = nextUrl;
    if (nextUrl !== normalizedUrl || nextToken !== token) {
      setKnowledge(empty());
      setSelectedDocument(null);
      setKnowledgeAnchor('');
    }
    if (nextUrl !== normalizedUrl) {
      setPets([]);
      setChannelDeliveries([]);
      setChannelFailures([]);
      setRoutingSkips([]);
      setSchedules(empty());
      setNotices(empty());
      setTriggers(empty());
      setSchedulerHistory([]);
      setTriggerHistory([]);
      setDispatchGoal('');
    }
    sessionStorage.setItem('studio.url', nextUrl);
    sessionStorage.setItem('studio.token', nextToken);
    setBaseUrl(nextUrl);
    setToken(nextToken);
    setDispatches((current) => nextUrl === normalizedUrl ? markObservationLost(current) : []);
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
    if (activeHost.current !== normalizedUrl) throw new Error('Request belongs to the previous Studio Host. Check that Host for its outcome.');
    if (!response.ok) throw new Error(value?.error ?? `${path} failed (${response.status.toString()}).`);
    void refreshRef.current().catch((error) => setNotice(connectionErrorMessage(error)));
    return value as T;
  };

  const openDocument = async (documentPath: string, anchor = '') => {
    if (selectedDocument?.path === documentPath && anchor) {
      knowledgeRequest.current++;
      setKnowledgeAnchor(anchor);
      return;
    }
    const request = ++knowledgeRequest.current;
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
      if (request !== knowledgeRequest.current || activeHost.current !== normalizedUrl) return;
      setKnowledgeAnchor(anchor);
      setSelectedDocument(value.document);
    } catch (error) {
      if (request === knowledgeRequest.current && activeHost.current === normalizedUrl)
        setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (page !== 'knowledge' || selectedDocument || !knowledge.value?.length) return;
    const initial = knowledge.value.find(({ path }) => path === 'PROJECT.md') ?? knowledge.value[0];
    void openDocument(initial.path);
  }, [page, knowledge.value, selectedDocument]);

  const reloadKnowledge = async () => {
    const epoch = observationEpoch.current;
    const listRequest = ++knowledgeListRequest.current;
    const documentRequest = knowledgeRequest.current;
    const current = () => epoch === observationEpoch.current && listRequest === knowledgeListRequest.current;
    try {
      const response = await fetch(`${normalizedUrl}/knowledge`, { headers });
      if (!current()) return;
      if (response.status === 401 || response.status === 403) {
        knowledgeRequest.current++;
        setKnowledge({ value: null, unavailable: false, error: 'Knowledge access is no longer available.' });
        setSelectedDocument(null);
        return;
      }
      if (response.status === 404) {
        if (documentRequest !== knowledgeRequest.current) return;
        setKnowledge({ value: null, unavailable: true });
        setSelectedDocument(null);
        return;
      }
      const value = await response.json().catch(() => null) as {
        documents?: ProjectDocumentSummary[];
        error?: string;
      } | null;
      if (!current()) return;
      if (!response.ok || !value?.documents) {
        throw new Error(value?.error ?? `Knowledge refresh failed (${response.status.toString()}).`);
      }
      setKnowledge({ value: value.documents, unavailable: false });
      // A newer page or anchor selection wins over a slower list refresh.
      if (documentRequest === knowledgeRequest.current) {
        if (selectedDocument?.path
          && value.documents.some(({ path }) => path === selectedDocument.path)) {
          await openDocument(selectedDocument.path);
        } else {
          setSelectedDocument(null);
          const initial = value.documents.find(({ path }) => path === 'PROJECT.md') ?? value.documents[0];
          if (initial) await openDocument(initial.path);
        }
      }
      if (current()) setNotice('Knowledge refreshed.');
    } catch (error) {
      if (current()) setNotice(error instanceof Error ? error.message : String(error));
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

  const openDispatch = () => {
    setDispatchGoal('');
    setDispatchPet(pets[0]?.petId ?? '');
    setDispatchDrawerOpen(true);
  };

  const submitDispatch = (event: FormEvent) => {
    event.preventDefault();
    if (dispatchSubmittingRef.current || connectionState !== 'connected') return;
    const request = dispatchGoal.trim();
    if (!dispatchPet || !request) {
      setNotice('Dispatch requires a Pet and a message.');
      return;
    }
    dispatchSubmittingRef.current = true;
    setDispatchSubmitting(true);
    const submittedEpoch = observationEpoch.current;
    void post<{ petId: string; invocationId: string }>('/dispatch', {
      petId: dispatchPet,
      request,
    }).then((receipt) => {
      setDispatchGoal('');
      setDispatchDrawerOpen(false);
      setDispatches((current) => appendDispatchRecord(current, {
        invocationId: receipt.invocationId,
        petId: receipt.petId,
        request,
        producer: 'http',
        state: 'queued',
        updatedAt: new Date().toISOString(),
        source: 'admission_receipt',
        observationLost: submittedEpoch !== observationEpoch.current,
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
    if (!canRetryDispatch(dispatch) || connectionState !== 'connected') return;
    setRetryingInvocationId(dispatch.invocationId);
    const submittedEpoch = observationEpoch.current;
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
        observationLost: submittedEpoch !== observationEpoch.current,
      }));
      setNotice(`Retry accepted for ${receipt.petId}.`);
    }).catch((error) => setNotice(connectionErrorMessage(error))).finally(() => {
      setRetryingInvocationId('');
    });
  };

  const retryTriggerDelivery = (deliveryId: string) => {
    setRetryingDeliveryId(deliveryId);
    void post('/triggers/control', { action: 'retry', deliveryId }).then(() => {
      setNotice(`Trigger delivery ${deliveryId} was retried.`);
    }).catch((error) => {
      setNotice(connectionErrorMessage(error));
    }).finally(() => setRetryingDeliveryId(''));
  };

  const redeliverTriggerDelivery = (deliveryId: string) => {
    setRetryingDeliveryId(deliveryId);
    void post('/triggers/control', { action: 'redeliver', deliveryId }).then(() => {
      setNotice(`Trigger delivery ${deliveryId} was redelivered.`);
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
    <main className={'shell' + (page === 'channel' ? ' channel-shell' : '')}>
      <aside className="rail">
        <div className="rail-brand" title="PinPawo Studio Console"><img src={logoMark} alt="PinPawo" width={24} height={24} /></div>
        <nav aria-label="Studio pages">
          {pageItems.filter(item => !clientMode || item.page === 'channel').map(({ page: item, label, Icon }) => (
            <button className={'rail-item' + (page === item ? ' active' : '')} aria-current={page === item ? 'page' : undefined}
              aria-label={label} data-tip={label} key={item} onClick={() => setPage(item)} type="button"><Icon size={19} strokeWidth={1.75} aria-hidden /></button>
          ))}
        </nav>
        <button className={`rail-item rail-connection ${connectionState}`} aria-label="Connection" data-tip={'Connection · ' + connectionState} onClick={() => {
          setConnectionUrlDraft(baseUrl);
          setConnectionTokenDraft(token);
          setConnectionModalOpen(true);
        }} type="button"><Plug size={18} strokeWidth={1.75} aria-hidden /><i aria-hidden /></button>
      </aside>
      <section className={'content' + (page === 'channel' ? ' channel-content' : '')}>
        <div className="channel-page" hidden={page !== 'channel'}>
          <ChannelPanel key={`${normalizedUrl}:${token}`} url={normalizedUrl} token={token}
            active={page === 'channel'} connected={connectionState === 'connected'} refreshVersion={channelVersion} pets={pets} petsReady={petsReady}
            deliveries={channelDeliveries} routingSkips={routingSkips} failures={channelFailures} clientMode={clientMode}
            onOpenKnowledge={identity?.scope === 'studio' ? () => setPage('knowledge') : undefined} />
        </div>
        {connectionError && <div className="connection-alert" role="alert">
          <strong>Connection failed</strong>
          <span>{connectionError}</span>
        </div>}
        {page === 'scheduler' && (schedules.value ? <>
          <div className="section-title"><span>One-shot schedules</span><b>{schedules.value.length}</b></div>
          <form className="composer scheduler" onSubmit={submitSchedule}>
            <select onChange={(event) => setSchedulePet(event.target.value)} value={schedulePet}>{pets.map((pet) => <option key={pet.petId} value={pet.petId}>{pet.petId}</option>)}</select>
            <input onChange={(event) => setScheduleRequest(event.target.value)} placeholder="Scheduled goal…" value={scheduleRequest} />
            <input onChange={(event) => setScheduleRunAt(event.target.value)} type="datetime-local" value={scheduleRunAt} />
            <button>Schedule</button>
          </form>
          <div className="rows">{schedules.value.map((schedule) => <div className="row" key={schedule.scheduleId}><em className={schedule.status}>{schedule.status}</em><time>{new Date(schedule.runAt).toLocaleString()}</time><strong>{schedule.request}</strong><span>{schedule.petId}{schedule.note ? ` · ${schedule.note}` : ''}{schedule.status === 'scheduled' && <button className="inline-action" onClick={() => { void post('/scheduler/control', { action: 'cancel', scheduleId: schedule.scheduleId }).catch((error) => setNotice(String(error))); }} type="button">cancel</button>}</span></div>)}</div>
          <History title="Scheduler history" events={schedulerHistory} />
        </> : unavailable(schedules, 'Scheduler'))}
        {page === 'notice' && (notices.value ? <>
          <div className="section-title"><span>Notices</span><b>{notices.value.length}</b></div>
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
          <div className="section-title"><span>Triggers</span><b>{triggers.value.triggers.length}</b></div>
          <div className="rows">{triggers.value.triggers.map((trigger) => <div className="row" key={trigger.triggerId}><code>{trigger.triggerId}</code><strong>{triggerRequestLabel(trigger.request)}</strong><span>{triggerSourceLabel(trigger.source)} → {trigger.target.kind === 'pet' ? trigger.target.petId : trigger.target.path}</span></div>)}</div>
          <div className="hint">POST /triggers/invoke · Authorization: Trigger &lt;secret&gt; · body: triggerId, idempotencyKey, payload</div>
          <div className="section-title"><span>Deliveries</span><b>{triggers.value.deliveries.length}</b></div>
          <div className="rows">{triggers.value.deliveries.map((delivery) => <div className="row" key={delivery.deliveryId}><em className={delivery.status}>{delivery.status}</em><code>{delivery.triggerId}</code><strong>{delivery.idempotencyKey}</strong><span>{delivery.note ?? new Date(delivery.occurredAt).toLocaleString()}{delivery.status === 'failed' && <button className="inline-action" disabled={retryingDeliveryId === delivery.deliveryId} onClick={() => retryTriggerDelivery(delivery.deliveryId)} type="button">{retryingDeliveryId === delivery.deliveryId ? 'retrying…' : 'retry'}</button>}{delivery.status === 'accepted' && <button aria-label={`Redeliver ${delivery.deliveryId}`} className="inline-action" disabled={retryingDeliveryId === delivery.deliveryId} onClick={() => redeliverTriggerDelivery(delivery.deliveryId)} title="Send this accepted request again. Use only when its execution did not start or was interrupted." type="button">{retryingDeliveryId === delivery.deliveryId ? 'redelivering…' : 'redeliver'}</button>}</span></div>)}</div>
          <History title="Trigger history" events={triggerHistory} />
        </> : unavailable(triggers, 'Trigger'))}
        {page === 'knowledge' && (knowledge.value ? <>
          <div className="section-title"><span>Project Wiki</span><span><button className="title-action" onClick={() => { void reloadKnowledge(); }} type="button">Refresh</button><b>{knowledge.value.length}</b></span></div>
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
                ? <><div className="knowledge-document-path">{selectedDocument.path}</div>
                  <KnowledgeDocument path={selectedDocument.path} content={selectedDocument.content}
                    paths={knowledge.value.map(({ path }) => path)} anchor={knowledgeAnchor}
                    onNavigate={(path, anchor) => { void openDocument(path, anchor); }} /></>
                : knowledge.value.length === 0
                  ? <div className="empty-state"><strong>No Wiki pages yet</strong><span>Project Wiki pages will appear here when they are added to the project.</span></div>
                  : <div className="empty-state"><strong>Select a Wiki page</strong><span>The project Wiki is read-only here.</span></div>}
            </article>
          </div>
        </> : unavailable(knowledge, 'Project Files'))}
      </section>
      {page !== 'channel' && !clientMode && <button className="dispatch-launcher" disabled={connectionState !== 'connected'} onClick={() => openDispatch()} type="button">
        <span>+</span> Dispatch
      </button>}
      {dispatchDrawerOpen && <div className="drawer-layer" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget && !dispatchSubmitting) setDispatchDrawerOpen(false);
      }}>
        <aside aria-label="Dispatch to Pet" aria-modal="true" className="dispatch-drawer" role="dialog">
          <div className="drawer-head">
            <div><span>New dispatch</span><strong>Send work to a resident Pet</strong></div>
            <button aria-label="Close dispatch" disabled={dispatchSubmitting} onClick={() => setDispatchDrawerOpen(false)} type="button">×</button>
          </div>
          <form className="drawer-composer" onSubmit={submitDispatch}>
            <label className="composer-target">
              <span>Dispatch to</span>
              <select disabled={dispatchSubmitting} onChange={(event) => setDispatchPet(event.target.value)} value={dispatchPet}>
                {pets.map((pet) => <option key={pet.petId} value={pet.petId}>{pet.name} ({pet.petId})</option>)}
              </select>
            </label>
            <div className="chat-input">
              <label htmlFor="dispatch-goal">Message</label>
              <textarea
                autoFocus
                id="dispatch-goal"
                onChange={(event) => setDispatchGoal(event.target.value)}
                onKeyDown={submitDispatchOnEnter}
                placeholder="Describe the goal for this Pet…"
                rows={7}
                value={dispatchGoal}
              />
              <div className="chat-actions">
                <span>Enter to send / Shift+Enter for a new line</span>
                <button disabled={dispatchSubmitting || connectionState !== 'connected' || !dispatchPet || !dispatchGoal.trim()}>
                  {dispatchSubmitting ? 'Sending…' : 'Dispatch'}
                </button>
              </div>
            </div>
          </form>
          <div className="drawer-activity">
            <div className="section-title"><span>Recent activity</span><b>{dispatches.length}</b></div>
            {dispatches.length > 0 ? dispatches.slice(-6).reverse().map((dispatch) => <div className="dispatch-activity" key={dispatch.invocationId}>
              <em className={dispatch.observationLost ? 'unknown' : dispatch.state}>{dispatch.observationLost ? 'status unknown' : dispatch.state === 'completed' ? 'invocation ended' : dispatch.state}</em>
              <strong>{dispatch.request}</strong>
              {dispatch.observationLost && <small>Observation interrupted. Last seen: {dispatch.state}. Check this Pet’s session for its current state.</small>}
              {!dispatch.observationLost && dispatch.state === 'completed' && <small>Check the Pet session for its reply and verify the requested outcome.</small>}
              {!dispatch.observationLost && dispatch.state === 'waiting' && <small>Interaction needed. Use the Pet TUI connection command from the Host startup output with Pet {dispatch.petId}. Review details and approval are available there.</small>}
              <span>{dispatch.petId}{dispatch.error ? ` · ${dispatch.error}` : ''}{dispatch.state === 'failed' && canRetryDispatch(dispatch) && <button className="inline-action" disabled={connectionState !== 'connected' || retryingInvocationId === dispatch.invocationId} onClick={() => retryDispatch(dispatch)} type="button">retry</button>}</span>
            </div>) : <div className="compact-empty">No dispatch activity in this Console session.</div>}
          </div>
        </aside>
      </div>}
      {connectionModalOpen && <div className="modal-layer" role="presentation">
        <form aria-label="Connect to Studio" aria-modal="true" className="connection-modal" onSubmit={connect} role="dialog">
          <div className="modal-title"><span>Studio connection</span><strong>Connect this Console to a running Studio Host</strong></div>
          <label><span>Host URL</span><input aria-label="Studio HTTP URL" autoFocus onChange={(event) => setConnectionUrlDraft(event.target.value)} value={connectionUrlDraft} /></label>
          <label><span>Bearer token</span><input aria-label="Studio bearer token" onChange={(event) => setConnectionTokenDraft(event.target.value)} placeholder="Paste token" type="password" value={connectionTokenDraft} /></label>
          {connectionError && <div className="modal-error" role="alert">{connectionError}</div>}
          <div className="modal-actions">
            {connectionState === 'connected' && <button onClick={() => setConnectionModalOpen(false)} type="button">Cancel</button>}
            <button disabled={connectionState === 'connecting'}>{connectionState === 'connecting' ? 'Connecting…' : 'Connect'}</button>
          </div>
        </form>
      </div>}
      <footer>
        <span className={`connection-state ${connectionState}`} role="status">
          <i />{connectionState}{identity && connectionState === 'connected' ? ` · ${identity.clientId}` : ''}
        </span>
        <span className="footer-notice">{notice}</span>
      </footer>
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
        <span>{event.scheduleId ?? event.deliveryId ?? event.triggerId ?? event.status ?? event.note ?? '—'}</span>
      </div>
    ))}</div>
  </>;
}
