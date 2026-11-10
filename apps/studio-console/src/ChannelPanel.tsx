import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DispatchRecord } from './dispatchActivity';
import { ChannelTimeline } from './ChannelConversation';
import { useChannelBreakpoint, useChannelDialogFocus } from './channelFocus';
import { ChannelDispatchQueues } from './ChannelDispatchQueues';
import { ChannelMessageInput, type ChannelMessageInputHandle } from './ChannelMessageInput';
import { PetSessionView } from './PetSessionView';
import type { PetSessionTarget } from './petSession';
import {
  appendChannelDeliveries, channelCanEditPrompt, channelInactivePets, channelMemberRemovalInput, channelPetCreateInput, channelMessageIdentity, channelMessageInput, channelMessageSummary, channelPetIdentity,
  channelPetSession, channelReplyRecipientId, channelWindowAfterEarlier, channelWindowAfterLater, mergeChannelMessages,
  readChannelContext, readChannelLater, readChannelPages, type ChannelWindow,
  type ChannelPetDefinition, type ChannelPetRecord, type ChannelContext, type ChannelDelivery, type ChannelRoutingSkip, type ChannelMember, type ChannelMessage, type ChannelRow, type ChannelSession, type DispatchQueue,
} from './channelData';

type Props = {
  url: string; token: string; connected: boolean; refreshVersion: number;
  /** A client key or JWT: no dispatch queues or Pet sessions, which are the local token's. */
  clientMode?: boolean;
  /** Open the local project's existing Wiki; not available to Channel-only clients. */
  onOpenKnowledge?: () => void;
  onPetsChanged?: () => void;
  active?: boolean;
  pets: { petId: string; name: string }[];
  petsReady?: boolean;
  /** Delivery outcomes observed on the Studio event stream. */
  deliveries?: ChannelDelivery[];
  /** Live execution failures, distinct from admission and saving a reply. */
  dispatches?: DispatchRecord[];
  /** Unaddressed messages Channel routing gave to nobody. */
  routingSkips?: ChannelRoutingSkip[];
  /** Pet replies the Host could not save into a Channel. */
  failures?: { channelId: string; petId?: string; error: string }[];
};
type OpenChannel = Omit<ChannelContext, 'messages' | 'nextAfter' | 'hasMore' | 'nextBefore' | 'hasEarlier'>;

export function ChannelDispatchFailures({ channelId, dispatches, pets, petsReady }: {
  channelId: string; dispatches: DispatchRecord[]; pets: { petId: string; name: string }[]; petsReady: boolean;
}) {
  return <>{dispatches.filter(item => item.state === 'failed' && item.scope?.namespace === 'channel'
    && item.scope.id === channelId).map(item => <p className="channel-record-error" role="alert" key={item.invocationId}>
      {channelPetIdentity(item.petId, pets, petsReady).name} execution failed: {item.error ?? 'Unknown error'}
    </p>)}</>;
}

export function ChannelPanel({ url, token, connected, refreshVersion, active = true, pets, petsReady = true, deliveries = [], dispatches = [], routingSkips = [], failures = [], clientMode = false, onOpenKnowledge, onPetsChanged }: Props) {
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [selected, setSelected] = useState('');
  const [context, setContext] = useState<OpenChannel | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [sessions, setSessions] = useState<ChannelSession[]>([]);
  const [sent, setSent] = useState<ChannelDelivery[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [memberError, setMemberError] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [createPrompt, setCreatePrompt] = useState('');
  const [promptEditing, setPromptEditing] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');
  const [promptError, setPromptError] = useState('');
  const [definitions, setDefinitions] = useState<ChannelPetDefinition[]>([]);
  const [definitionError, setDefinitionError] = useState('');
  const [petRecords, setPetRecords] = useState<ChannelPetRecord[]>([]);
  const [petRecordsError, setPetRecordsError] = useState('');
  const [lifecycleStatus, setLifecycleStatus] = useState('');
  const [body, setBody] = useState('');
  const [joiningPet, setJoiningPet] = useState('');
  const [joiningHuman, setJoiningHuman] = useState('');
  const [queues, setQueues] = useState<DispatchQueue[]>([]);
  const [queueError, setQueueError] = useState('');
  const [reply, setReply] = useState<ChannelMessage | undefined>();
  const [localVersion, setLocalVersion] = useState(0);
  const [sessionView, setSessionView] = useState<PetSessionTarget | null>(null);
  const [held, setHeld] = useState<ChannelWindow | null>(null);
  const heldRef = useRef<ChannelWindow | null>(null);
  const windows = useRef(0);
  const updateHeld = (next: ChannelWindow | null) => { heldRef.current = next; setHeld(next); };
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const submitting = useRef(false);
  const composer = useRef<ChannelMessageInputHandle>(null);
  const composerForm = useRef<HTMLFormElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const activity = useRef<HTMLElement>(null);
  const createDialog = useRef<HTMLFormElement>(null);
  const followLatest = useRef(true);
  const viewerPosition = useRef<{ top: number; follow: boolean } | null>(null);
  const focusComposer = useRef(false);
  const [atLatest, setAtLatest] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 1100);
  const [highlightedMessage, setHighlightedMessage] = useState('');
  const navigationDrawer = useChannelBreakpoint('(max-width: 700px)');
  const activityDrawer = useChannelBreakpoint('(max-width: 1100px)');
  const navigationModal = navigationDrawer && navigationOpen;
  const activityModal = activityDrawer && activityOpen;
  useChannelDialogFocus(navigationModal, navigation, () => setNavigationOpen(false));
  useChannelDialogFocus(activityModal, activity, () => setActivityOpen(false));
  useChannelDialogFocus(creating, createDialog, () => { if (!submitting.current) setCreating(false); });
  useEffect(() => { if (activityDrawer) setActivityOpen(false); }, [activityDrawer]);
  useEffect(() => { if (!navigationDrawer) setNavigationOpen(false); }, [navigationDrawer]);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => { lifetime.current.abort(); };
  }, []);
  const read = useCallback(async (path: string, signal: AbortSignal = lifetime.current.signal) => {
    const response = await fetch(`${url}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal });
    const value = await response.json().catch(() => null);
    if (response.status === 404 && path.startsWith('/channels?')) throw new Error('Channel Plugin unavailable (404).');
    if (!response.ok) throw new Error(value?.error ?? `${path} failed (${response.status}).`);
    return value;
  }, [url, token]);
  const refresh = () => setLocalVersion(value => value + 1);

  useEffect(() => {
    setDefinitions([]); setDefinitionError('');
    if (!connected || clientMode) return;
    const abort = new AbortController();
    void read('/pet-definitions', abort.signal).then(value => {
      if (!abort.signal.aborted) setDefinitions(value.definitions ?? []);
    }).catch(reason => { if (!abort.signal.aborted) setDefinitionError(String(reason)); });
    return () => abort.abort();
  }, [connected, clientMode, read]);

  useEffect(() => {
    if (!connected || clientMode) { setPetRecords([]); setPetRecordsError(''); return; }
    const abort = new AbortController();
    void read('/pets/records', abort.signal).then(value => {
      if (!Array.isArray(value.pets)) throw new Error('Invalid Pet records response.');
      if (!abort.signal.aborted) { setPetRecords(value.pets); setPetRecordsError(''); }
    }).catch(reason => { if (!abort.signal.aborted) setPetRecordsError(String(reason)); });
    return () => abort.abort();
  }, [connected, clientMode, refreshVersion, localVersion, read]);

  useEffect(() => {
    setSessionView(current => current && petRecords.some(pet => pet.petId === current.petId && (pet.closedAt || pet.removedAt)) ? null : current);
  }, [petRecords]);

  useEffect(() => {
    if (!connected || !active || clientMode) return;
    const abort = new AbortController();
    const load = async () => {
      try {
        const value = await read('/dispatch/queues', abort.signal) as { queues: DispatchQueue[] };
        if (!Array.isArray(value.queues)) throw new Error('Invalid dispatch queue response.');
        if (!abort.signal.aborted) { setQueues(value.queues); setQueueError(''); }
      } catch (reason) { if (!abort.signal.aborted) setQueueError(String(reason)); }
    };
    void load();
    const timer = setInterval(() => { void load(); }, 1500);
    return () => { abort.abort(); clearInterval(timer); };
  }, [connected, active, clientMode, refreshVersion, localVersion, read]);

  useEffect(() => {
    if (!connected) return;
    const abort = new AbortController();
    void readChannelPages<ChannelRow>(path => read(path, abort.signal), '/channels', 'channels')
      .then(values => {
        setChannels(values); setUnavailable(false);
        setSelected(current => values.some(item => item.channelId === current) ? current : values[0]?.channelId ?? '');
      }).catch(reason => {
        if (abort.signal.aborted) return;
        if (String(reason).includes('(404)')) setUnavailable(true);
        else setError(String(reason));
      });
    return () => abort.abort();
  }, [connected, refreshVersion, localVersion, read]);

  // Opening a Channel reads its newest page; every later refresh reads only what came after the newest message held.
  useEffect(() => {
    if (!connected || !selected) return;
    const abort = new AbortController();
    setLoading(true);
    const request = (path: string) => read(path, abort.signal);
    const holding = heldRef.current?.channelId === selected ? heldRef.current : null;
    void Promise.all([
      holding ? readChannelLater(request, selected, holding.nextAfter) : readChannelContext(request, selected),
      request(`/channels/sessions?channelId=${encodeURIComponent(selected)}`) as Promise<{ sessions: ChannelSession[] }>,
    ]).then(([next, bindings]) => {
      if (abort.signal.aborted) return;
      // An older page may have landed meanwhile: move only the newer edge of the window this read was for.
      const nextWindow = holding ? channelWindowAfterLater(heldRef.current, holding, next.nextAfter)
        : { channelId: selected, window: ++windows.current, nextAfter: next.nextAfter, nextBefore: next.nextBefore, hasEarlier: next.hasEarlier };
      if (!nextWindow) return;
      setContext({ channel: next.channel, members: next.members, viewerParticipantId: next.viewerParticipantId, working: next.working ?? [] });
      setMessages(current => holding ? mergeChannelMessages(current, next.messages) : next.messages);
      updateHeld(nextWindow);
      setSessions(Array.isArray(bindings.sessions) ? bindings.sessions : []);
    }).catch(reason => { if (!abort.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selected, connected, refreshVersion, localVersion, read]);

  // Older messages are read one page at a time; the reader keeps its place.
  const loadEarlier = async () => {
    const holding = heldRef.current;
    if (!holding?.hasEarlier || loadingEarlier) return;
    const element = timeline.current;
    const fromBottom = element ? element.scrollHeight - element.scrollTop : 0;
    setLoadingEarlier(true);
    try {
      const page = await readChannelContext(path => read(path), holding.channelId, holding.nextBefore);
      // A page read for a window that was since reopened or refreshed would leave a gap: drop it.
      const nextWindow = channelWindowAfterEarlier(heldRef.current, holding, page);
      if (!nextWindow) return;
      setMessages(messages => mergeChannelMessages(page.messages, messages));
      updateHeld(nextWindow);
      requestAnimationFrame(() => { if (element) element.scrollTop = element.scrollHeight - fromBottom; });
    } catch (reason) {
      if (!lifetime.current.signal.aborted) setError(String(reason));
    } finally {
      if (!lifetime.current.signal.aborted) setLoadingEarlier(false);
    }
  };

  const selectChannel = (id: string) => {
    if (submitting.current) return;
    // The loader only reruns when the selection changes, so the open Channel keeps its view.
    if (id === selected) { setNavigationOpen(false); return; }
    setSelected(id); setContext(null); setMessages([]); setSessions([]); updateHeld(null);
    setReply(undefined); setBody(''); setError(''); setMemberError(''); setLifecycleStatus(''); setJoiningHuman('');
    setPromptEditing(false); setPromptDraft(''); setPromptError('');
    setHighlightedMessage(''); setNavigationOpen(false);
    followLatest.current = true; setAtLatest(true);
  };
  const post = async (path: string, value: unknown) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', signal: lifetime.current.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error ?? `Request failed (${response.status}).`);
    return result;
  };
  const submit = async (work: () => Promise<void>, fail: (message: string) => void = message => setError(`${message} Check the timeline before submitting again.`)) => {
    if (submitting.current || !connected) return;
    submitting.current = true; setPending(true); setError(''); setMemberError('');
    try { await work(); }
    catch (reason) { if (!lifetime.current.signal.aborted) fail(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      submitting.current = false;
      if (!lifetime.current.signal.aborted) { setPending(false); refresh(); }
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    void submit(async () => {
      const value = await post('/channels', {
        title: title.trim(), ...(description.trim() ? { description: description.trim() } : {}),
        ...(!clientMode && createPrompt.trim() ? { prompt: createPrompt.trim() } : {}), pets: [],
      }) as { channel: ChannelRow; members: ChannelMember[] };
      setChannels(current => [...current, value.channel]); setSelected(value.channel.channelId);
      setContext(null); setMessages([]); setSessions([]); updateHeld(null); setReply(undefined); setBody('');
      followLatest.current = true; focusComposer.current = true; setAtLatest(true);
      setHighlightedMessage(''); setNavigationOpen(false);
      setCreating(false); setTitle(''); setDescription(''); setCreatePrompt(''); setActivityOpen(true);
      setPromptEditing(false); setPromptDraft(''); setPromptError('');
    });
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    void submit(async () => {
      followLatest.current = true;
      const result = await post('/channels/messages', channelMessageInput(selected, '', body, reply)) as ChannelMessage & {
        deliveries?: Omit<ChannelDelivery, 'channelId' | 'messageId'>[];
      };
      setBody(''); setReply(undefined); composer.current?.reset();
      if (result.deliveries?.length) {
        setSent(current => appendChannelDeliveries(current, result.deliveries!.map(item => ({ ...item, channelId: result.channelId, messageId: result.messageId }))));
      }
    });
  };
  const savePrompt = (event: FormEvent) => {
    event.preventDefault();
    const channelId = selected;
    void submit(async () => {
      const channel = await post('/channels/update', { channelId, prompt: promptDraft.trim() || null }) as ChannelRow;
      setChannels(current => current.map(item => item.channelId === channelId ? channel : item));
      setContext(current => current?.channel.channelId === channelId ? { ...current, channel } : current);
      setPromptEditing(false); setPromptError('');
    }, setPromptError);
  };
  const manageMember = (path: string, member: { kind: string; id: string }, done?: () => void) => {
    void submit(async () => {
      await post(path, { channelId: selected, kind: member.kind, id: member.id });
      done?.();
    }, setMemberError);
  };

  const confirmPetStop = (name: string, action: 'close' | 'remove') => window.confirm(action === 'close'
    ? `Close ${name}? This will interrupt its current task, cancel unstarted queued tasks, and wait for it to stop before automatically closing it. History is retained and you can reopen this instance. Pending approvals will not be answered or resumed.`
    : `Permanently remove ${name}? This will interrupt its current task, cancel unstarted queued tasks, and wait for it to stop before automatically removing it. History is retained. Pending approvals will not be answered or resumed. This cannot be undone.`);
  const removeMember = (member: ChannelMember) => {
    if (submitting.current || !connected) return;
    if (member.kind === 'pet' && !confirmPetStop(member.label, 'remove')) return;
    void submit(async () => {
      if (member.kind === 'pet') setLifecycleStatus('Stopping current work and canceling unstarted tasks. Waiting for permanent removal…');
      await post('/channels/members/remove', channelMemberRemovalInput(selected, member, true));
      if (member.kind === 'pet') {
        setSessionView(current => current?.petId === member.id ? null : current);
        setLifecycleStatus('Pet permanently removed. History retained.'); onPetsChanged?.();
      }
    }, message => { setLifecycleStatus(''); setMemberError(member.kind === 'pet' ? `Removal not confirmed: ${message} Check its state before retrying.` : message); });
  };
  const managePet = (pet: ChannelPetRecord, action: 'close' | 'reopen' | 'remove') => {
    if (submitting.current || !connected || clientMode) return;
    if (action !== 'reopen' && !confirmPetStop(pet.name, action)) return;
    void submit(async () => {
      setLifecycleStatus(action === 'remove' ? 'Waiting for permanent removal…'
        : action === 'close' ? 'Stopping current work and canceling unstarted tasks. Waiting to close…' : 'Reopening Pet…');
      await post(`/pets/${action}`, { petId: pet.petId, ...(action !== 'reopen' ? { confirmStop: true } : {}) });
      if (action !== 'reopen') setSessionView(current => current?.petId === pet.petId ? null : current);
      setLifecycleStatus(action === 'remove' ? 'Pet permanently removed. History retained.'
        : action === 'close' ? 'Pet closed. It can be reopened here. History retained.' : 'Pet reopened in its owner Channel.');
      onPetsChanged?.();
    }, message => { setLifecycleStatus(''); setMemberError(`${action === 'remove' ? 'Removal' : action === 'close' ? 'Close' : 'Reopen'} not confirmed: ${message} Check its state before retrying.`); });
  };

  const lastSequence = messages.at(-1)?.sequence;
  const working = context?.working ?? [];
  useEffect(() => {
    if (active && followLatest.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [active, selected, lastSequence, working.length]);
  useEffect(() => {
    if (context && focusComposer.current) { focusComposer.current = false; composer.current?.focus(); }
  }, [context]);
  const locateMessage = (messageId: string) => {
    setHighlightedMessage(messageId);
    followLatest.current = false;
    if (activityDrawer) setActivityOpen(false);
    requestAnimationFrame(() => {
      const element = document.getElementById('message-' + messageId);
      element?.scrollIntoView({ block: 'center', behavior: 'auto' });
      element?.focus({ preventScroll: true });
    });
  };
  const viewSession = (session: ChannelSession) => setSessionView({ petId: session.petId, sessionId: session.sessionId });

  const modalOpen = navigationModal || activityModal || creating;
  const selectedChannel = context?.channel ?? channels.find(item => item.channelId === selected);
  const selectedFailures = failures.filter(item => item.channelId === selected);
  const members = context?.members ?? [];
  const viewerParticipantId = context?.viewerParticipantId;
  const memberName = (member: ChannelMember) => member.participantId === viewerParticipantId ? 'Me' : member.label;
  const mentionCandidates = members.map(member => ({ participantId: member.participantId, kind: member.kind, label: memberName(member) }));
  const inactivePets = channelInactivePets(petRecords, selected);
  const identityPets = [...petRecords.filter(record => !pets.some(pet => pet.petId === record.petId)), ...pets];
  const definitionToAdd = definitions.find(item => item.definitionId === joiningPet) ?? definitions[0];
  return <div className={'channel-layout' + (activityOpen && !activityDrawer ? ' with-activity' : '')}>
    {(navigationModal || activityModal) && <button className="channel-scrim" type="button" tabIndex={-1} aria-label="Close panel"
      onClick={() => { setNavigationOpen(false); setActivityOpen(false); }} />}
    <aside ref={navigation} aria-label="Channel navigation" role={navigationModal ? 'dialog' : 'navigation'}
      aria-modal={navigationModal ? true : undefined} tabIndex={-1}
      hidden={navigationDrawer && !navigationOpen} inert={modalOpen && !navigationModal}
      className={'channel-navigation' + (navigationModal ? ' channel-drawer left' : '')}>
      <div className="channel-sidebar-head"><h2>Channels</h2>
        {navigationModal && <button type="button" aria-label="Close Channel navigation" onClick={() => setNavigationOpen(false)}>×</button>}
      </div>
      <button className="channel-new" type="button" disabled={!connected || pending || unavailable} onClick={() => { setNavigationOpen(false); setCreating(true); }}>+ New Channel</button>
      <div className="channel-list">
        {channels.map(item => <button key={item.channelId} disabled={pending} className={item.channelId === selected ? 'active' : ''} aria-current={item.channelId === selected ? 'page' : undefined}
          title={item.description ? `${item.title} — ${item.description}` : item.title}
          onClick={() => selectChannel(item.channelId)}><strong><span aria-hidden="true">#</span> {item.title}</strong>{item.description && <span>{item.description}</span>}</button>)}
        {!channels.length && <div className="compact-empty">{connected ? 'No Channels yet.' : 'Connect to read your Channels.'}</div>}
      </div>
      <div className="channel-sidebar-foot">{connected ? 'One conversation for all members.' : 'Disconnected · submissions disabled'}</div>
    </aside>
    <section className="channel-detail" aria-label="Channel conversation" aria-busy={loading} inert={modalOpen}>
      <div className="channel-conversation-head">
        {navigationDrawer && <button className="channel-panel-toggle" type="button" aria-label="Show Channel navigation" aria-expanded={navigationOpen}
          onClick={() => { setActivityOpen(false); setNavigationOpen(true); }}>☰</button>}
        <div className="channel-heading"><h2>{selectedChannel?.title ?? 'Channel workspace'}</h2>
          <p title={selectedChannel?.description}>{selectedChannel?.description ?? 'A shared conversation between people and Pets.'}</p></div>
        {onOpenKnowledge && !clientMode && <button className="channel-panel-toggle channel-wiki-link" type="button"
          aria-label="View project Wiki" onClick={onOpenKnowledge}>Wiki</button>}
        <button className="channel-panel-toggle activity-toggle" type="button" aria-label={activityOpen ? 'Hide Channel details' : 'Show Channel details'}
          aria-expanded={activityOpen} aria-controls="channel-activity-panel" onClick={() => { setNavigationOpen(false); setActivityOpen(value => !value); }}>
          Members <span>{members.length}</span>
        </button>
      </div>
      {!connected && <div className="channel-connection-note" role="status">Connection interrupted. Stored history remains visible; new messages and deliveries are unknown until reconnected.</div>}
      {unavailable ? <div className="empty-state"><strong>Channel Plugin unavailable</strong><span>Enable the Channel Plugin on this Studio Host to use this page.</span></div>
        : context ? <>
          <div className="channel-timeline-region">
            <div ref={timeline} className="channel-timeline-scroll" role="log" aria-label="Channel messages" aria-live="polite" aria-relevant="additions"
              onScroll={() => {
                const element = timeline.current!;
                const latest = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                if (!viewerPosition.current) { followLatest.current = latest; setAtLatest(latest); }
              }}>
              {held?.hasEarlier && <button className="channel-earlier" type="button" disabled={loadingEarlier || !connected}
                onClick={() => { void loadEarlier(); }}>{loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}</button>}
              <ChannelTimeline messages={messages} pets={identityPets} petsReady={petsReady} connected={connected} highlighted={highlightedMessage} artifactSource={{ url, token }}
                members={members} viewerParticipantId={viewerParticipantId} deliveries={appendChannelDeliveries(sent, deliveries)} routingSkips={routingSkips} working={working}
                sessions={sessions} onViewSession={clientMode ? undefined : viewSession}
                onViewerChange={open => {
                  if (open) {
                    viewerPosition.current = { top: timeline.current?.scrollTop ?? 0, follow: followLatest.current };
                    followLatest.current = false;
                  } else if (viewerPosition.current) {
                    if (timeline.current) timeline.current.scrollTop = viewerPosition.current.top;
                    followLatest.current = viewerPosition.current.follow;
                    viewerPosition.current = null;
                  }
                }}
                pending={pending || !connected} onLocateMessage={locateMessage}
                onReply={item => {
                  setReply(item);
                  const author = mentionCandidates.find(member => member.participantId === channelReplyRecipientId(item.author, members));
                  composer.current?.reset(author);
                }} />
              <ChannelDispatchFailures channelId={selected} dispatches={dispatches} pets={pets} petsReady={petsReady} />
              {error && <p className="channel-record-error channel-send-error" role="alert">Message was not delivered: {error}</p>}
              {selectedFailures.map((item, index) => <p className="channel-record-error" role="alert" key={index}>
                {item.petId ? `${channelPetIdentity(item.petId, pets, petsReady).name} reply was not saved` : 'Pet reply was not saved'}: {item.error}</p>)}
            </div>
            {!atLatest && <button className="channel-jump" type="button" onClick={() => {
              followLatest.current = true; setAtLatest(true);
              timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: 'auto' });
            }}>Back to latest ↓</button>}
          </div>
          <form ref={composerForm} className="channel-composer" onSubmit={send}>
            {reply && <div className="channel-composer-quote">
              <button className="channel-quote" type="button" onClick={() => locateMessage(reply.messageId)}>
                <strong>{'Reply to ' + channelMessageIdentity(reply, pets, petsReady, members, viewerParticipantId).name}</strong><span>{channelMessageSummary(reply)}</span>
              </button>
              <button type="button" aria-label="Cancel reply" disabled={pending} onClick={() => { setReply(undefined); composer.current?.focus(); }}>×</button>
            </div>}
            <div className="chat-input channel-chat-input">
              <ChannelMessageInput ref={composer} members={mentionCandidates} disabled={pending} onChange={setBody}
                placeholder={reply ? 'Write a reply…' : `Message ${selectedChannel?.title ?? 'this Channel'} · type @ to mention a member`}
                onSubmit={() => { if (body.trim() && connected && !pending) composerForm.current?.requestSubmit(); }} />
              <div className="channel-composer-controls">
                <p className="channel-composer-hint"><kbd>@</kbd> mention · <kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> new line
                  · Without an @, no Pet is woken unless Channel routing picks one.</p>
                <button className="channel-send" disabled={pending || !connected || !body.trim()}>{pending ? 'Sending…' : 'Send message'}</button>
              </div>
            </div>
          </form>
        </> : <div className="empty-state"><strong>{loading ? 'Loading Channel…' : 'Start a Channel'}</strong>
          <span>Talk with people and Pets in one shared conversation.</span>
          {error && <p className="channel-record-error" role="alert">{error}</p>}
          {!loading && <button type="button" disabled={!connected || pending} onClick={() => setCreating(true)}>New Channel</button>}
        </div>}
    </section>
    <aside id="channel-activity-panel" ref={activity} hidden={!activityOpen} role={activityModal ? 'dialog' : 'complementary'}
      aria-label="Channel details" aria-modal={activityModal ? true : undefined} tabIndex={-1} inert={modalOpen && !activityModal}
      className={'channel-activity' + (activityModal ? ' channel-drawer right' : '')}>
      <div className="channel-sidebar-head"><h2>Members <span className="channel-count">{members.length}</span></h2>
        <button type="button" aria-label="Close Channel details" onClick={() => setActivityOpen(false)}>×</button></div>
      <div className="channel-activity-scroll">
        {context && <section className="channel-activity-section channel-instructions" aria-label="Channel instructions">
          <div className="channel-section-label"><h3>Channel instructions</h3>
            {!promptEditing && channelCanEditPrompt(clientMode) && <button type="button" disabled={!connected || pending}
              onClick={() => { setPromptDraft(context.channel.prompt ?? ''); setPromptError(''); setPromptEditing(true); }}>Edit</button>}
          </div>
          <p className="channel-history-hint">Used for new Channel tasks. Existing tasks keep their instructions.</p>
          {!channelCanEditPrompt(clientMode) && <p className="channel-history-hint">Only the Studio owner can edit these instructions.</p>}
          {promptEditing ? <form onSubmit={savePrompt}>
            <textarea aria-label="Edit Channel instructions" maxLength={50_000} rows={6} value={promptDraft}
              disabled={!connected || pending} onChange={event => setPromptDraft(event.target.value)} />
            {promptError && <p className="channel-record-error" role="alert">{promptError}</p>}
            <div className="channel-instructions-actions"><button type="button" disabled={pending} onClick={() => { setPromptEditing(false); setPromptError(''); }}>Cancel</button>
              <button type="submit" disabled={!connected || pending}>Save instructions</button></div>
          </form> : <p className="channel-instructions-text">{context.channel.prompt || 'No shared instructions yet.'}</p>}
        </section>}
        {context && <section className="channel-activity-section" aria-label="Channel members">
          <p className="channel-history-hint">Only members can read, post and be addressed here.</p>
          <ul className="channel-members">{members.map(member => {
            const session = member.kind === 'pet' ? channelPetSession(member.id, sessions) : undefined;
            const name = memberName(member);
            const self = member.participantId === viewerParticipantId;
            return <li className="channel-member" key={member.participantId}>
              <span className={'channel-avatar small ' + member.kind} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
              <div className="channel-member-main">
                <div className="channel-member-head"><strong>{name}</strong><em className={'channel-kind ' + member.kind}>{member.kind === 'pet' ? 'Pet' : 'Human'}</em></div>
                <code title={member.participantId}>{member.participantId}</code>
              </div>
              <div className="channel-member-actions">
                {session && !clientMode && <button type="button" disabled={!connected} aria-label="View session" onClick={() => viewSession(session)}>Session</button>}
                {member.kind === 'pet' && !session && <span>No session yet</span>}
                {member.kind === 'pet' && !clientMode && <button type="button" disabled={!connected || pending} aria-label={'Close Pet ' + name}
                  onClick={() => managePet({ petId: member.id, name, channelId: selected }, 'close')}>Close Pet</button>}
                {/* The Console cannot remove its own member. */}
                {!self && <button type="button" className="channel-member-remove" aria-label={(member.kind === 'pet' ? 'Permanently remove Pet ' : 'Remove ') + name} disabled={!connected || pending}
                  onClick={() => removeMember(member)}>{member.kind === 'pet' ? 'Remove Pet' : 'Remove'}</button>}
              </div>
            </li>;
          })}</ul>
          <div className="channel-member-adders">
            {!clientMode && <form className="channel-member-add" onSubmit={event => {
              event.preventDefault();
              if (definitionToAdd) void submit(async () => {
                await post('/pets', channelPetCreateInput(selected, definitionToAdd, clientMode));
              }, message => setMemberError(message + ' Check members before creating another instance.'));
            }}>
              <select aria-label="Pet definition" disabled={pending || !definitions.length} value={definitionToAdd?.definitionId ?? ''} onChange={event => setJoiningPet(event.target.value)}>
                {!definitions.length && <option value="">No Pet definitions available</option>}
                {definitions.map(definition => <option key={definition.definitionId} value={definition.definitionId}>{definition.name} ({definition.definitionId})</option>)}
              </select>
              <button disabled={!connected || pending || !definitionToAdd}>Create Pet here</button>
            </form>}
            {!clientMode && definitionError && <p className="channel-record-error" role="alert">{definitionError}</p>}
            <p className="channel-history-hint">Each Pet belongs only to this Channel. Close is temporary and can be reopened. Remove is permanent and retains history.</p>
            <form className="channel-member-add" onSubmit={event => {
              event.preventDefault();
              if (joiningHuman.trim()) manageMember('/channels/members', { kind: 'human', id: joiningHuman.trim() }, () => setJoiningHuman(''));
            }}>
              <input aria-label="Human member ID" placeholder="Studio client ID" maxLength={256} disabled={pending} value={joiningHuman} onChange={event => setJoiningHuman(event.target.value)} />
              <button disabled={!connected || pending || !joiningHuman.trim()}>Add human</button>
            </form>
          </div>
          {lifecycleStatus && <p className="channel-history-hint" role="status">{lifecycleStatus}</p>}
          {memberError && <p className="channel-record-error" role="alert">{memberError}</p>}
        </section>}
        {!clientMode && <section className="channel-activity-section" aria-label="Inactive Pets">
          <div className="channel-section-label"><h3>Inactive Pets</h3></div>
          {petRecordsError && <p className="channel-record-error" role="alert">{petRecordsError}</p>}
          {!inactivePets.length && !petRecordsError && <p className="channel-history-hint">No closed or permanently removed Pets in this Channel.</p>}
          <ul className="channel-members">{inactivePets.map(pet => <li className="channel-member" key={pet.petId}>
            <div className="channel-member-main"><strong>{pet.name}</strong><code>{pet.petId}</code>
              <span>{pet.removedAt ? 'Permanently removed · history retained' : 'Closed · can reopen'}</span></div>
            {!pet.removedAt && <div className="channel-member-actions">
              <button type="button" disabled={!connected || pending} aria-label={'Reopen Pet ' + pet.name} onClick={() => managePet(pet, 'reopen')}>Reopen</button>
              <button type="button" disabled={!connected || pending} aria-label={'Permanently remove Pet ' + pet.name} onClick={() => managePet(pet, 'remove')}>Remove Pet</button>
            </div>}
          </li>)}</ul>
        </section>}
        {messages.length > 0 && !clientMode && <ChannelDispatchQueues queues={queues} pets={pets} channels={channels} connected={connected} error={queueError} />}
        <button className="channel-refresh" type="button" disabled={!connected || pending}
          onClick={() => { updateHeld(null); refresh(); }}>↻ Refresh persisted history</button>
      </div>
    </aside>
    {sessionView && <PetSessionView url={url} token={token} target={sessionView} pets={pets} petsReady={petsReady}
      onClose={() => setSessionView(null)} />}
    {creating && <div className="modal-layer" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !submitting.current) setCreating(false);
    }}><form ref={createDialog} aria-label="Create Channel" aria-modal="true" role="dialog" className="connection-modal channel-create-dialog" onSubmit={create}>
      <div className="modal-title"><span>New Channel</span><strong>Start a shared conversation</strong></div>
      {error && <div className="modal-error" role="alert">{error}</div>}
      <label><span>Title</span><input data-initial-focus aria-label="Channel title" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label><span>Description (optional)</span><textarea aria-label="Channel description" maxLength={50_000} value={description} onChange={event => setDescription(event.target.value)} rows={3} /></label>
      {!clientMode && <label><span>Channel instructions (optional)</span><textarea aria-label="Channel instructions" maxLength={50_000} value={createPrompt} onChange={event => setCreatePrompt(event.target.value)} rows={3} placeholder="How should members work together?" /></label>}
      <p>{clientMode ? 'A Studio operator can create Pet instances here after the Channel is created.' : 'Create the Channel first, then create its Pet instances from definitions in the members panel.'}</p>
      <div className="modal-actions"><button type="button" disabled={pending} onClick={() => setCreating(false)}>Cancel</button>
        <button disabled={pending || !connected || !title.trim()}>{pending ? 'Creating…' : 'Create Channel'}</button></div>
    </form></div>}
  </div>;
}

export { ChannelTimeline } from './ChannelConversation';
