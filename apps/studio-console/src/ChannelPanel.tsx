import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ChannelCopy, ChannelTimeline, ChannelExecutionHistory } from './ChannelConversation';
import { useChannelBreakpoint, useChannelDialogFocus } from './channelFocus';
import {
  channelExecuteInput, channelMessageIdentity, channelPetIdentity, channelQuote, readChannelPages,
  type ChannelGoal, type ChannelContext, type ChannelEntry, type ChannelMessage, type ChannelExecution, type ChannelNotice,
} from './channelData';

type Props = {
  url: string; token: string; connected: boolean; refreshVersion: number;
  active?: boolean;
  pets: { petId: string; name: string }[];
  petsReady?: boolean;
  failures: { channelId: string; invocationId?: string; error: string }[];
};

export function ChannelPanel({ url, token, connected, refreshVersion, active = true, pets, petsReady = true, failures }: Props) {
  const [channels, setChannels] = useState<ChannelGoal[]>([]);
  const [selected, setSelected] = useState('');
  const [context, setContext] = useState<ChannelContext | null>(null);
  const [entries, setEntries] = useState<ChannelEntry[]>([]);
  const [executions, setExecutions] = useState<ChannelExecution[]>([]);
  const [notices, setNotices] = useState<ChannelNotice[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('');
  const [body, setBody] = useState('');
  const [petId, setPetId] = useState('');
  const [reply, setReply] = useState<ChannelMessage | undefined>();
  const [localVersion, setLocalVersion] = useState(0);
  const submitting = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const activity = useRef<HTMLElement>(null);
  const createDialog = useRef<HTMLFormElement>(null);
  const followLatest = useRef(true);
  const focusComposer = useRef(false);
  const [atLatest, setAtLatest] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 1100);
  const [highlightedMessage, setHighlightedMessage] = useState('');
  const [highlightedExecution, setHighlightedExecution] = useState('');
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
    if (response.status === 404) throw new Error('Channel Plugin unavailable (404).');
    if (!response.ok) throw new Error(value?.error ?? `${path} failed (${response.status}).`);
    return value;
  }, [url, token]);
  const refresh = () => setLocalVersion(value => value + 1);

  useEffect(() => {
    if (!connected) return;
    const abort = new AbortController();
    void readChannelPages<ChannelGoal>(path => read(path, abort.signal), '/channels', 'channels')
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

  useEffect(() => {
    if (!connected || !selected) return;
    const abort = new AbortController();
    setLoading(true);
    const id = encodeURIComponent(selected);
    const request = (path: string) => read(path, abort.signal);
    void Promise.all([
      request(`/channels/context?channelId=${id}&limit=200`) as Promise<ChannelContext>,
      readChannelPages<ChannelExecution>(request, `/channels/executions?channelId=${id}`, 'executions'),
      readChannelPages<ChannelNotice>(request, `/channels/interrupts?channelId=${id}`, 'notifications'),
    ]).then(async ([nextContext, nextExecutions, nextNotices]) => {
      const history = [...nextContext.history.entries];
      let cursor = nextContext.history;
      while (cursor.hasMore) {
        const next = await request(`/channels/context?channelId=${id}&after=${cursor.nextAfter}&limit=200`) as ChannelContext;
        if (next.history.nextAfter <= cursor.nextAfter) throw new Error('Channel history cursor did not advance.');
        history.push(...next.history.entries); cursor = next.history;
      }
      if (abort.signal.aborted) return;
      setContext(nextContext); setEntries(history); setExecutions(nextExecutions); setNotices(nextNotices);
    }).catch(reason => { if (!abort.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [selected, connected, refreshVersion, localVersion, read]);

  useEffect(() => {
    if (!connected || !executions.some(item => !item.observationLost && ['admitting', 'queued', 'running'].includes(item.state))) return;
    const timer = setInterval(() => setLocalVersion(value => value + 1), 2000);
    return () => clearInterval(timer);
  }, [connected, executions]);

  const selectChannel = (id: string) => {
    if (submitting.current) return;
    setSelected(id); setContext(null); setEntries([]); setExecutions([]); setNotices([]);
    setReply(undefined); setBody(''); setPetId(''); setError('');
    setHighlightedMessage(''); setHighlightedExecution(''); setNavigationOpen(false);
    followLatest.current = true; setAtLatest(true);
  };
  const post = async (path: string, value: unknown) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', signal: lifetime.current.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error ?? `Request failed (${response.status}).`);
    return result;
  };
  const submit = async (work: () => Promise<void>) => {
    if (submitting.current || !connected) return;
    submitting.current = true; setPending(true); setError('');
    try { await work(); }
    catch (reason) { if (!lifetime.current.signal.aborted) setError(`${reason instanceof Error ? reason.message : String(reason)} Check the timeline before submitting again.`); }
    finally {
      submitting.current = false;
      if (!lifetime.current.signal.aborted) { setPending(false); refresh(); }
    }
  };
  const create = (event: FormEvent) => {
    event.preventDefault();
    void submit(async () => {
      const value = await post('/channels', { title: title.trim(), goal: goal.trim(), scope: scope.trim() }) as ChannelGoal;
      setChannels(current => [...current, value]); setSelected(value.channelId); setContext(null);
      setEntries([]); setExecutions([]); setNotices([]); setReply(undefined); setBody('');
      setPetId('');
      followLatest.current = true; focusComposer.current = true; setAtLatest(true);
      setHighlightedMessage(''); setHighlightedExecution(''); setNavigationOpen(false);
      setCreating(false); setTitle(''); setGoal(''); setScope('');
    });
  };
  const execute = (event: FormEvent) => {
    event.preventDefault();
    void submit(async () => {
      followLatest.current = true;
      await post('/channels/execute', channelExecuteInput(selected, petId, body, reply));
      setBody(''); setReply(undefined);
    });
  };
  const saveNote = () => void submit(async () => {
    if (!body.trim()) return;
    followLatest.current = true;
    await post('/channels/messages', { channelId: selected, body: body.trim() });
    setBody('');
  });

  const lastSequence = entries.at(-1)?.sequence;
  useEffect(() => {
    if (active && followLatest.current && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [active, selected, lastSequence]);
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
  const locateExecution = (executionId: string) => {
    setHighlightedExecution(executionId); setActivityOpen(true);
    requestAnimationFrame(() => {
      const element = document.getElementById('execution-' + executionId);
      element?.scrollIntoView({ block: 'center', behavior: 'auto' });
      element?.focus({ preventScroll: true });
    });
  };

  const modalOpen = navigationModal || activityModal || creating;
  const selectedGoal = context?.channel ?? channels.find(item => item.channelId === selected);
  const selectedFailures = failures.filter(item => item.channelId === selected);
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
          onClick={() => selectChannel(item.channelId)}><strong><span aria-hidden="true">#</span> {item.title}</strong><span>{item.scope}</span></button>)}
        {!channels.length && <div className="compact-empty">{connected ? 'No Channels yet.' : 'Connect to read your Channels.'}</div>}
      </div>
      <div className="channel-sidebar-foot">{connected ? 'Notes stay here. Execution is explicit.' : 'Disconnected · submissions disabled'}</div>
    </aside>
    <section className="channel-detail" aria-label="Channel conversation" aria-busy={loading} inert={modalOpen}>
      <div className="channel-conversation-head">
        {navigationDrawer && <button className="channel-panel-toggle" type="button" aria-label="Show Channel navigation" aria-expanded={navigationOpen}
          onClick={() => { setActivityOpen(false); setNavigationOpen(true); }}>☰</button>}
        <div className="channel-heading"><h2>{selectedGoal?.title ?? 'Channel workspace'}</h2>
          <p title={selectedGoal?.goal}>{selectedGoal?.goal ?? 'A shared goal, public deliveries and the next round of work.'}</p></div>
        <button className="channel-panel-toggle activity-toggle" type="button" aria-label={activityOpen ? 'Hide execution details' : 'Show execution details'}
          aria-expanded={activityOpen} aria-controls="channel-activity-panel" onClick={() => { setNavigationOpen(false); setActivityOpen(value => !value); }}>
          Activity <span>{executions.length}</span>
        </button>
      </div>
      {!connected && <div className="channel-connection-note" role="status">Connection interrupted. Stored history remains visible; unfinished execution state is unknown.</div>}
      {unavailable ? <div className="empty-state"><strong>Channel Plugin unavailable</strong><span>Enable the Channel Plugin on this Studio Host to use this page.</span></div>
        : context ? <>
          <div className="channel-timeline-region">
            <div ref={timeline} className="channel-timeline-scroll" role="log" aria-label="Channel messages" aria-live="polite" aria-relevant="additions"
              onScroll={() => {
                const element = timeline.current!;
                const latest = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                followLatest.current = latest; setAtLatest(latest);
              }}>
              <ChannelTimeline entries={entries} pets={pets} petsReady={petsReady} executions={executions} connected={connected} highlighted={highlightedMessage}
                pending={pending || !connected} onLocateMessage={locateMessage} onLocateExecution={locateExecution}
                onReply={item => { setReply(item); setPetId(item.source!.petId); setBody(''); composer.current?.focus(); }} />
            </div>
            {!atLatest && <button className="channel-jump" type="button" onClick={() => {
              followLatest.current = true; setAtLatest(true);
              timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: 'auto' });
            }}>Back to latest ↓</button>}
          </div>
          <form className="channel-composer" onSubmit={execute}>
            {error && <div className="channel-record-error" role="alert">{error}</div>}
            {reply && <div className="channel-composer-quote">
              <button className="channel-quote" type="button" onClick={() => locateMessage(reply.messageId)}>
                <strong>{'Reply to ' + channelMessageIdentity(reply, pets, petsReady).name + ' · same session'}</strong><span>{channelQuote(reply.body)}</span>
              </button>
              <button type="button" aria-label="Cancel reply" disabled={pending} onClick={() => { setReply(undefined); composer.current?.focus(); }}>×</button>
            </div>}
            <div className="chat-input"><label htmlFor="channel-message">Message</label>
              <textarea ref={composer} id="channel-message" disabled={pending} value={body} onChange={event => setBody(event.target.value)}
                placeholder={reply ? 'Reply to this Pet…' : 'Describe this round of work, or save a note…'} rows={3} />
              <div className="channel-composer-controls">
                <label className="composer-target"><span>{reply ? 'Reply to Pet' : 'Execute with Pet'}</span>
                  <select aria-label="Channel target Pet" disabled={pending || !!reply} value={petId} onChange={event => setPetId(event.target.value)}>
                    <option value="">Select a Pet…</option>{pets.map(pet => <option key={pet.petId} value={pet.petId}>{channelPetIdentity(pet.petId, pets).optionLabel}</option>)}
                  </select>
                </label>
                <div className="channel-send-actions">{!reply && <button type="button" disabled={pending || !connected || !body.trim()} onClick={saveNote}>Save note</button>}
                  <button disabled={pending || !connected || !body.trim() || (!reply && !petId)}>{pending ? 'Sending…' : reply ? 'Send reply' : 'Send to Pet'}</button>
                </div>
              </div>
            </div>
            <p className="channel-composer-hint">Notes and @ text do not run Pets. Sending starts one round.</p>
          </form>
        </> : <div className="empty-state"><strong>{loading ? 'Loading Channel…' : 'Start a Channel'}</strong>
          <span>Keep the goal and public work together across rounds.</span>
          {error && <p className="channel-record-error" role="alert">{error}</p>}
          {!loading && <button type="button" disabled={!connected || pending} onClick={() => setCreating(true)}>New Channel</button>}
        </div>}
    </section>
    <aside id="channel-activity-panel" ref={activity} hidden={!activityOpen} role={activityModal ? 'dialog' : 'complementary'}
      aria-label="Channel execution details" aria-modal={activityModal ? true : undefined} tabIndex={-1} inert={modalOpen && !activityModal}
      className={'channel-activity' + (activityModal ? ' channel-drawer right' : '')}>
      <div className="channel-sidebar-head"><h2>Activity & details</h2><button type="button" aria-label="Close execution details" onClick={() => setActivityOpen(false)}>×</button></div>
      <div className="channel-activity-scroll">
        <div className="channel-activity-section"><div className="channel-section-label"><h3>Execution history</h3><span>{executions.length}</span></div>
          <p className="channel-history-hint">Last recorded observations. An ended invocation does not mean the goal is complete.</p>
          <ChannelExecutionHistory executions={executions} pets={pets} petsReady={petsReady} entries={entries} connected={connected}
            highlighted={highlightedExecution} onLocateMessage={locateMessage} />
          {selectedFailures.map((item, index) => <p className="channel-record-error" role="alert" key={index}>Channel storage failed: {item.error}</p>)}
        </div>
        {notices.length > 0 && <details className="channel-notices"><summary>Review notification history ({notices.length})</summary>
          <p>Historical notifications only. Inspect and decide in the original Pet TUI; approval output is not automatically returned here.</p>
          {notices.map(item => <div className="channel-review" key={item.sequence}>
            <strong>{channelPetIdentity(item.source.petId, pets, petsReady).name} · review requested</strong>
            {channelPetIdentity(item.source.petId, pets, petsReady).removed && <span className="channel-removed">Removed Pet</span>}
            <time>{new Date(item.occurredAt).toLocaleString()}</time>
            {item.pendingInterrupt.payload.interactions.map((interaction, index) => <p key={index}>{interaction.view.title ?? interaction.view.body ?? 'Review details are available in the original TUI.'}</p>)}
            <details className="channel-technical"><summary>Technical details</summary>
              <dl><dt>Pet</dt><dd><code>{item.source.petId}</code></dd><dt>Session</dt><dd><ChannelCopy label="review session ID" value={item.source.sessionId} /></dd></dl>
              <pre>{JSON.stringify(item.pendingInterrupt, null, 2)}</pre>
            </details>
          </div>)}
        </details>}
        {context && <details className="channel-goal-details"><summary>Goal & current scope</summary><p>{context.channel.goal}</p><strong>Current scope</strong><p>{context.channel.scope}</p>
          {context.channel.references.map((reference, index) => <div className="channel-artifact" key={index}><code>{reference.label ?? reference.uri}</code></div>)}
        </details>}
        {context && <details className="channel-session-details"><summary>Pet sessions ({context.sessions.length})</summary>
          {context.sessions.map(item => <div className="channel-session" key={item.petId}><strong>{channelPetIdentity(item.petId, pets, petsReady).name}</strong>
            {channelPetIdentity(item.petId, pets, petsReady).removed && <span className="channel-removed">Removed Pet</span>}
            {!item.registered && <span>Registration pending</span>}<ChannelCopy label="Pet session ID" value={item.sessionId} /></div>)}
        </details>}
        <button className="channel-refresh" type="button" disabled={!connected || pending} onClick={refresh}>Refresh persisted history</button>
      </div>
    </aside>
    {creating && <div className="modal-layer" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget && !submitting.current) setCreating(false);
    }}><form ref={createDialog} aria-label="Create Channel" aria-modal="true" role="dialog" className="connection-modal" onSubmit={create}>
      <div className="modal-title"><span>New Channel</span><strong>A long-term goal and a first scope</strong></div>
      {error && <div className="modal-error" role="alert">{error}</div>}
      <label><span>Title</span><input data-initial-focus aria-label="Channel title" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label><span>Goal</span><textarea aria-label="Channel goal" required value={goal} onChange={event => setGoal(event.target.value)} rows={4} /></label>
      <label><span>Current scope</span><textarea aria-label="Channel scope" required value={scope} onChange={event => setScope(event.target.value)} rows={3} /></label>
      <div className="modal-actions"><button type="button" disabled={pending} onClick={() => setCreating(false)}>Cancel</button>
        <button disabled={pending || !connected || !title.trim() || !goal.trim() || !scope.trim()}>{pending ? 'Creating…' : 'Create Channel'}</button></div>
    </form></div>}
  </div>;
}

export { ChannelTimeline, ChannelExecutionHistory } from './ChannelConversation';
