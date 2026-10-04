import React, { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  channelExecuteInput, executionLabel, readChannelPages,
  type ChannelGoal, type ChannelContext, type ChannelEntry, type ChannelMessage, type ChannelExecution, type ChannelNotice,
} from './channelData';

type Props = {
  url: string; token: string; connected: boolean; refreshVersion: number;
  pets: { petId: string; name: string }[];
  failures: { channelId: string; invocationId?: string; error: string }[];
};

export function ChannelPanel({ url, token, connected, refreshVersion, pets, failures }: Props) {
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
      setCreating(false); setTitle(''); setGoal(''); setScope('');
    });
  };
  const execute = (event: FormEvent) => {
    event.preventDefault();
    void submit(async () => {
      await post('/channels/execute', channelExecuteInput(selected, petId, body, reply));
      setBody(''); setReply(undefined);
    });
  };
  const saveNote = () => void submit(async () => {
    if (!body.trim()) return;
    await post('/channels/messages', { channelId: selected, body: body.trim() });
    setBody('');
  });

  if (unavailable) return <div className="empty-state"><strong>Channel Plugin unavailable</strong><span>Enable the Channel Plugin on this Studio Host to use this page.</span></div>;
  return <>
    <div className="section-title"><span>CHANNELS</span><span><button className="title-action" disabled={!connected || pending} onClick={refresh}>REFRESH</button><button className="title-action" disabled={!connected || pending} onClick={() => setCreating(true)}>NEW CHANNEL</button></span></div>
    {error && <div className="connection-alert" role="alert">{error}</div>}
    <div className="channel-layout">
      <aside className="channel-list" aria-label="Channel list">
        {channels.map(item => <button key={item.channelId} disabled={pending} className={item.channelId === selected ? 'active' : ''} onClick={() => selectChannel(item.channelId)}><strong>{item.title}</strong><span>{item.scope}</span></button>)}
        {!channels.length && <div className="compact-empty">No Channels yet. Create a goal to begin.</div>}
      </aside>
      <div className="channel-detail" aria-busy={loading}>
        {context ? <>
          <div className="channel-goal"><h2>{context.channel.title}</h2><p>{context.channel.goal}</p><strong>CURRENT SCOPE</strong><p>{context.channel.scope}</p>
            <div className="channel-sessions">{context.sessions.map(item => <span key={item.petId}>{item.petId} · <code title={item.sessionId}>{item.sessionId}</code>{!item.registered && ' · registration pending'}</span>)}</div>
          </div>
          <div className="section-title"><span>MESSAGE TIMELINE</span><b>{entries.filter(item => item.kind === 'message').length}</b></div>
          <ChannelTimeline entries={entries} pending={pending || !connected} onReply={item => { setReply(item); setPetId(item.source!.petId); setBody(''); }} />
          <form className="channel-composer" onSubmit={execute}>
            {reply && <div className="task-reference"><span>REPLY TO {reply.source!.petId} · SAME SESSION</span><p>{reply.body}</p><button className="title-action" type="button" disabled={pending} onClick={() => setReply(undefined)}>CANCEL REPLY</button></div>}
            <label className="composer-target"><span>{reply ? 'REPLY TO PET' : 'EXECUTE WITH PET'}</span><select aria-label="Channel target Pet" disabled={pending || !!reply} value={petId} onChange={event => setPetId(event.target.value)}><option value="">Select a Pet…</option>{pets.map(pet => <option key={pet.petId} value={pet.petId}>{pet.name} ({pet.petId})</option>)}</select></label>
            <div className="chat-input"><label htmlFor="channel-message">MESSAGE</label><textarea id="channel-message" disabled={pending} value={body} onChange={event => setBody(event.target.value)} placeholder={reply ? 'Reply to this Pet…' : 'Describe this round of work…'} rows={4} />
              <div className="chat-actions"><span>Sending starts one round. Notes and @ text do not run Pets.</span><div>{!reply && <button type="button" disabled={pending || !connected || !body.trim()} onClick={saveNote}>SAVE NOTE</button>} <button disabled={pending || !connected || !body.trim() || (!reply && !petId)}>{pending ? 'SENDING…' : reply ? 'SEND REPLY' : 'SEND TO PET'}</button></div></div>
            </div>
          </form>
          <div className="section-title"><span>EXECUTION HISTORY · LAST RECORDED STATE</span><b>{executions.length}</b></div>
          <ChannelExecutionHistory executions={executions} connected={connected} />
          {failures.filter(item => item.channelId === selected).map((item, index) => <div className="connection-alert" role="alert" key={index}>Channel storage failed: {item.error}</div>)}
          {notices.length > 0 && <details className="channel-notices"><summary>Review notification history ({notices.length})</summary>{notices.map(item => <div className="hint" key={item.sequence}><strong>{item.source.petId} · review requested</strong><p>Use the original Pet TUI and session {item.source.sessionId} to inspect and decide. This historical notice does not establish a current pending review; approval output is not automatically returned here.</p></div>)}</details>}
        </> : <div className="empty-state"><strong>{loading ? 'Loading Channel…' : 'Select or create a Channel'}</strong><span>Goals and messages persist across rounds.</span></div>}
      </div>
    </div>
    {creating && <div className="modal-layer"><form aria-label="Create Channel" aria-modal="true" role="dialog" className="connection-modal" onSubmit={create}><div className="modal-title"><span>NEW CHANNEL</span><strong>Create a long-term goal</strong></div>
      <label><span>TITLE</span><input aria-label="Channel title" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label><span>GOAL</span><textarea aria-label="Channel goal" required value={goal} onChange={event => setGoal(event.target.value)} rows={4} /></label>
      <label><span>CURRENT SCOPE</span><textarea aria-label="Channel scope" required value={scope} onChange={event => setScope(event.target.value)} rows={3} /></label>
      <div className="modal-actions"><button type="button" disabled={pending} onClick={() => setCreating(false)}>CANCEL</button><button disabled={pending || !connected || !title.trim() || !goal.trim() || !scope.trim()}>{pending ? 'CREATING…' : 'CREATE CHANNEL'}</button></div>
    </form></div>}
  </>;
}

export function ChannelTimeline({ entries, pending, onReply }: { entries: ChannelEntry[]; pending: boolean; onReply: (item: ChannelMessage) => void }) {
  return <div className="channel-timeline">{entries.map(item => item.kind === 'revision'
    ? <details className="channel-revision" key={item.sequence}><summary>Goal revision · {item.reason} · {new Date(item.occurredAt).toLocaleString()}</summary><p>{item.goal}</p><p>{item.scope}</p></details>
    : <article className="channel-message" key={item.messageId} id={`message-${item.messageId}`}><div className="channel-message-head"><strong>{item.author.id}</strong><span>{item.author.kind} · {new Date(item.occurredAt).toLocaleString()}</span>{item.source && <button type="button" className="title-action" disabled={pending} onClick={() => onReply(item)}>REPLY TO {item.source.petId}</button>}</div>
      {item.replyTo && <a className="channel-reply-link" href={`#message-${item.replyTo}`}>In reply to {item.replyTo}</a>}
      <div className="task-note"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown></div>
      {item.artifacts.map((artifact, index) => <div className="channel-artifact" key={index}>{/^https?:\/\//i.test(artifact.uri) ? <a href={artifact.uri} target="_blank" rel="noreferrer">{artifact.label ?? artifact.uri}</a> : <code>{artifact.label ?? artifact.uri}</code>}{artifact.version && <span> · {artifact.version}</span>}</div>)}
    </article>)}</div>;
}

export function ChannelExecutionHistory({ executions, connected }: { executions: ChannelExecution[]; connected: boolean }) {
  return <div className="channel-executions">{!executions.length && <div className="compact-empty">No executions recorded.</div>}{[...executions].reverse().map(item => <div className="dispatch-activity" key={item.executionId}>
    <em className={item.observationLost ? 'unknown' : item.state}>{executionLabel(item, connected)}</em><strong>{item.petId}</strong>
    <span>{new Date(item.occurredAt).toLocaleString()}{item.messageId && <> · <a href={`#message-${item.messageId}`}>request</a></>}</span>
    {(item.observationLost || (!connected && ['admitting', 'queued', 'running', 'waiting'].includes(item.state))) && <small>Observation was interrupted. Last recorded: {item.state}. Refresh and inspect the Pet session; tasks are not replayed automatically.</small>}
    {item.state === 'waiting' && <small>Review was requested. Use the original Pet TUI and session {item.sessionId}; this record is not the current approval state.</small>}
    {item.error && <small role="alert">{item.error}</small>}{item.deliveryError && <small role="alert">Reply or notice storage failed: {item.deliveryError}</small>}
  </div>)}</div>;
}
