import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  AgentMessageEntry,
  AgentOperationEntry,
  AgentServerMessage,
  AgentSession,
  AgentSessionSnapshot,
  HumanReviewPendingInterruptProjection,
} from '@pinpawo/agent-session';
import { ChannelCopy, ChannelToolCalls } from './ChannelConversation';
import { channelPetIdentity, type ChannelPet } from './channelData';
import {
  applyPetSessionMessage,
  choosePetSessionReviewOption,
  currentPetSessionReview,
  observePetSession,
  petSessionQuery,
  readPetSessionReviewOutcome,
  readPetSessionSnapshot,
  type PetSessionReviewBody,
  type PetSessionReviewDraft,
  type PetSessionTarget,
} from './petSession';

export type PetSessionConnection = 'loading' | 'live' | 'reconnecting' | 'unavailable';

export type PetSessionSubmission =
  | { phase: 'sending' | 'waiting'; requestId: string }
  | { phase: 'error' | 'unknown'; message: string };

/** Stop waiting for a submitted answer's outcome and re-read the state instead. */
const REVIEW_OUTCOME_TIMEOUT_MS = 20_000;

/** randomUUID needs a secure context; a plain-HTTP Console still gets a unique id. */
function newRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function json(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function roleLabel(entry: AgentMessageEntry, petName: string): string {
  if (entry.role === 'assistant') return petName;
  if (entry.role === 'user') return 'Input';
  if (entry.role === 'subagent') return 'Subagent';
  return 'System';
}

function SessionMessage({ entry, petName }: { entry: AgentMessageEntry; petName: string }) {
  return <article className={'pet-session-entry message ' + entry.role} data-entry-id={entry.id}>
    <div className="pet-session-entry-head"><strong>{roleLabel(entry, petName)}</strong>
      {entry.status === 'streaming' && <span className="pet-session-streaming">Streaming…</span>}
      {entry.createdAt && <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>}</div>
    {entry.text.trim() && <div className="channel-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown></div>}
    {entry.toolCalls?.length ? <ChannelToolCalls calls={entry.toolCalls} /> : null}
    {entry.resultReferences?.map(reference => <details className="pet-session-reference" key={reference.id}>
      <summary>Result · {reference.title}</summary>
      <div className="channel-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reference.text}</ReactMarkdown></div>
    </details>)}
  </article>;
}

function SessionOperation({ entry }: { entry: AgentOperationEntry }) {
  const raw = entry.raw;
  return <details className={'pet-session-entry operation ' + entry.phase} data-entry-id={entry.id}>
    <summary><span>{entry.title}</span><em>{entry.phase}</em></summary>
    {entry.summary && <p>{entry.summary}</p>}
    {entry.target && <p><code>{entry.target}</code></p>}
    {entry.details && Object.keys(entry.details).length > 0 && <pre><code>{json(entry.details)}</code></pre>}
    {raw?.input !== undefined && <><strong>Input</strong><pre><code>{json(raw.input)}</code></pre></>}
    {raw?.output !== undefined && <><strong>Output</strong><pre><code>{json(raw.output)}</code></pre></>}
    {raw?.error !== undefined && <><strong>Error</strong><pre><code>{json(raw.error)}</code></pre></>}
  </details>;
}

/** The session's saved and live content, in the order the Host projected it. */
export function PetSessionTranscript({ session, petName }: { session: AgentSession; petName: string }) {
  if (!session.timeline.length) return <div className="compact-empty">This session has no messages yet.</div>;
  return <div className="pet-session-timeline">{session.timeline.map(entry => entry.type === 'message'
    ? <SessionMessage key={entry.id} entry={entry} petName={petName} />
    : <SessionOperation key={entry.id} entry={entry} />)}</div>;
}

export function petSessionRunLabel(session: AgentSession | null, connection: PetSessionConnection): string {
  if (connection === 'loading') return 'Loading';
  if (connection === 'unavailable') return 'Unavailable';
  if (connection === 'reconnecting') return 'Status unknown · observation interrupted';
  if (currentPetSessionReview(session)) return 'Waiting for review';
  if (session?.activeRun?.state === 'interrupting') return 'Stopping';
  if (session?.activeRun) return 'Running';
  return 'Idle';
}

type ReviewProps = {
  review: HumanReviewPendingInterruptProjection;
  draft: PetSessionReviewDraft | null;
  enabled: boolean;
  submission: PetSessionSubmission | null;
  onChoose: (optionId: string, inputText?: string) => string | null;
};

/** The current review, with the server's own options; nothing else is writable here. */
export function PetSessionReview({ review, draft, enabled, submission, onChoose }: ReviewProps) {
  const responses = draft?.interruptId === review.interruptId ? draft.responses : [];
  const interactions = review.payload.interactions;
  const interaction = interactions[responses.length] ?? interactions[0]!;
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');
  useEffect(() => { setSelected(''); setText(''); setProblem(''); }, [review.interruptId, interaction.interactionId]);
  const busy = submission?.phase === 'sending' || submission?.phase === 'waiting';
  const disabled = !enabled || busy;
  const selectedOption = interaction.options.find(option => option.id === selected);
  const choose = (optionId: string, inputText?: string) => {
    const reason = onChoose(optionId, inputText);
    setProblem(reason ?? '');
  };
  const view = interaction.view;
  return <section className="pet-session-review" aria-label="Current review">
    <div className="pet-session-review-head"><strong>Review {responses.length + 1} of {interactions.length}</strong>
      {view.title && <span>{view.title}</span>}</div>
    {view.kind === 'markdown' && <div className="channel-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{view.body}</ReactMarkdown></div>}
    {view.kind === 'plain' && <pre className="pet-session-review-plain">{view.body}</pre>}
    {view.kind === 'diff' && <>{view.target && <p><code>{view.target}</code></p>}{view.summary && <p>{view.summary}</p>}
      <pre className="pet-session-review-diff"><code>{view.patch.split('\n').map((line, index) => <span key={index}
        className={line.startsWith('+') && !line.startsWith('+++') ? 'added' : line.startsWith('-') && !line.startsWith('---') ? 'removed' : undefined}>{line + '\n'}</span>)}</code></pre></>}
    <div className="pet-session-review-options" role="group" aria-label="Review options">
      {interaction.options.map(option => <button type="button" key={option.id} disabled={disabled}
        className={(option.variant ?? 'normal') + (selected === option.id ? ' selected' : '')} title={option.description}
        aria-pressed={option.input ? selected === option.id : undefined}
        onClick={() => { if (option.input) { setSelected(option.id); setProblem(''); } else choose(option.id); }}>
        {option.label}
      </button>)}
    </div>
    {selectedOption?.input && <form className="pet-session-review-input" onSubmit={event => { event.preventDefault(); choose(selectedOption.id, text); }}>
      <label><span>{selectedOption.input.label ?? selectedOption.label}</span>
        {selectedOption.input.multiline
          ? <textarea value={text} disabled={disabled} rows={4} placeholder={selectedOption.input.placeholder} onChange={event => setText(event.target.value)} />
          : <input value={text} disabled={disabled} placeholder={selectedOption.input.placeholder} onChange={event => setText(event.target.value)} />}
      </label>
      <button disabled={disabled}>Submit {selectedOption.label}</button>
    </form>}
    {responses.length > 0 && <p className="pet-session-review-note">{responses.length} earlier answer{responses.length > 1 ? 's' : ''} will be sent together with this one.</p>}
    {!enabled && !busy && <p className="pet-session-review-note">Reviews can be answered only while the session is observed live.</p>}
    {busy && <p className="pet-session-review-note" role="status">{submission.phase === 'sending' ? 'Sending answer…' : 'Answer sent; waiting for the Pet to continue…'}</p>}
    {problem && <p className="channel-record-error" role="alert">{problem}</p>}
    {submission && (submission.phase === 'error' || submission.phase === 'unknown') && <p className="channel-record-error" role="alert">{submission.message}</p>}
  </section>;
}

type ViewProps = {
  url: string;
  token: string;
  target: PetSessionTarget;
  pets: ChannelPet[];
  petsReady?: boolean;
  onClose: () => void;
};

/**
 * A reader for one exact Pet session. Opening, closing and reconnecting send
 * no command: the only write is answering the current review.
 */
export function PetSessionView({ url, token, target, pets, petsReady = true, onClose }: ViewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const [session, setSession] = useState<AgentSession | null>(null);
  const [connection, setConnection] = useState<PetSessionConnection>('loading');
  const [problem, setProblem] = useState('');
  const [draft, setDraft] = useState<PetSessionReviewDraft | null>(null);
  const [submission, setSubmission] = useState<PetSessionSubmission | null>(null);
  const submissionRef = useRef<PetSessionSubmission | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const identity = channelPetIdentity(target.petId, pets, petsReady);
  const updateSubmission = (next: PetSessionSubmission | null) => { submissionRef.current = next; setSubmission(next); };

  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    if (typeof element.showModal === 'function' && !element.open) element.showModal();
    return () => {
      if (element.open) element.close();
      root.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const refreshSnapshot = async () => {
    try {
      const response = await fetch(`${url}/pet-sessions/snapshot?${petSessionQuery(target)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: lifetime.current?.signal,
      });
      const value = await response.json().catch(() => null) as { snapshot?: AgentSessionSnapshot; error?: string } | null;
      if (!response.ok || !value?.snapshot) throw new Error(value?.error ?? `Snapshot failed (${response.status}).`);
      setSession(readPetSessionSnapshot(value.snapshot, target));
    } catch (error) {
      if (!lifetime.current?.signal.aborted) setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    setSession(null); setConnection('loading'); setProblem(''); setDraft(null); updateSubmission(null);
    void observePetSession({
      url, token, target, signal: abort.signal,
      onConnected: () => undefined,
      onDisconnected: (error, retrying) => {
        setConnection(retrying ? 'reconnecting' : 'unavailable');
        setProblem(error.message);
      },
      onMessage: (message: AgentServerMessage) => {
        if (message.type === 'session.snapshot.result') { setConnection('live'); setProblem(''); }
        setSession(current => applyPetSessionMessage(current, message, target));
        const pending = submissionRef.current;
        if (pending && (pending.phase === 'sending' || pending.phase === 'waiting')) {
          const outcome = readPetSessionReviewOutcome(message, pending.requestId);
          if (outcome?.kind === 'accepted') { updateSubmission(null); setDraft(null); }
          if (outcome?.kind === 'refused') {
            updateSubmission({ phase: 'error', message: `${outcome.message} The current state was reloaded.` });
            setDraft(null);
            void refreshSnapshot();
          }
        }
      },
    });
    return () => abort.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, token, target.petId, target.sessionId]);

  const review = connection === 'unavailable' ? null : currentPetSessionReview(session);
  useEffect(() => {
    if (draft && draft.interruptId !== review?.interruptId) setDraft(null);
  }, [draft, review?.interruptId]);

  const timelineLength = session?.timeline.length ?? 0;
  const lastText = session?.timeline.at(-1)?.type === 'message' ? (session.timeline.at(-1) as AgentMessageEntry).text.length : 0;
  useEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [timelineLength, lastText, review?.interruptId]);

  const send = async (body: PetSessionReviewBody) => {
    updateSubmission({ phase: 'sending', requestId: body.requestId });
    try {
      const response = await fetch(`${url}/pet-sessions/review`, {
        method: 'POST', signal: lifetime.current?.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        updateSubmission({ phase: 'error', message: `${value?.error ?? `Review failed (${response.status}).`} The current state was reloaded.` });
        setDraft(null);
        void refreshSnapshot();
        return;
      }
      const current = submissionRef.current;
      if (current && 'requestId' in current && current.requestId === body.requestId) {
        updateSubmission({ phase: 'waiting', requestId: body.requestId });
        setTimeout(() => {
          const latest = submissionRef.current;
          if (!latest || !('requestId' in latest) || latest.requestId !== body.requestId || lifetime.current?.signal.aborted) return;
          updateSubmission({ phase: 'unknown', message: 'No outcome was observed yet. The current state was reloaded; the answer was not sent again.' });
          void refreshSnapshot();
        }, REVIEW_OUTCOME_TIMEOUT_MS);
      }
    } catch (error) {
      if (lifetime.current?.signal.aborted) return;
      // The answer may or may not have reached the Host: re-read, never resend.
      updateSubmission({ phase: 'unknown', message: 'Could not confirm that the answer reached the Host. The current state was reloaded; the answer was not sent again.' });
      void refreshSnapshot();
    }
  };

  const choose = (optionId: string, inputText?: string): string | null => {
    if (!review || connection !== 'live') return 'Reviews can be answered only while the session is observed live.';
    const step = choosePetSessionReviewOption({
      target, review, draft, optionId, ...(inputText !== undefined ? { inputText } : {}), requestId: newRequestId(),
    });
    if (step.kind === 'input-required') return 'Enter the requested text first.';
    if (step.kind === 'stale') { setDraft(null); void refreshSnapshot(); return 'This review changed. The current state was reloaded.'; }
    if (step.kind === 'collect') { setDraft(step.draft); return null; }
    void send(step.body);
    return null;
  };

  return <dialog ref={dialog} className="pet-session-viewer" aria-labelledby="pet-session-title" aria-describedby="pet-session-description"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="pet-session-head">
      <div>
        <h2 id="pet-session-title">{identity.name} session{identity.removed && <span className="channel-removed">Removed Pet</span>}</h2>
        <p id="pet-session-description">Read-only. Opening or closing this view does not change the Pet's active session.</p>
        <dl className="pet-session-identity">
          <dt>Session</dt><dd><ChannelCopy label="viewed session ID" value={target.sessionId} /></dd>
          {target.executionId && <><dt>Execution</dt><dd><ChannelCopy label="viewed execution ID" value={target.executionId} /></dd></>}
        </dl>
      </div>
      <div className="pet-session-head-actions">
        <span className={'pet-session-state ' + connection} role="status">{petSessionRunLabel(session, connection)}</span>
        <button type="button" autoFocus onClick={onClose} aria-label="Close session view">Close <span aria-hidden="true">×</span></button>
      </div>
    </header>
    {connection === 'reconnecting' && <div className="channel-connection-note" role="status">
      Observation interrupted{problem ? ` (${problem})` : ''}. Showing what was received; reviews are disabled until the session reconnects.</div>}
    {connection === 'unavailable' && <div className="channel-record-error" role="alert">
      This session is unavailable: {problem || 'the Host did not return it.'} Channel history is unaffected; nothing was started or created.</div>}
    {connection === 'live' && problem && <div className="channel-record-error" role="alert">{problem}</div>}
    <div className="pet-session-body">
      <div ref={scroller} className="pet-session-scroll" tabIndex={0} role="log" aria-label="Session messages"
        onScroll={() => {
          const element = scroller.current!;
          const latest = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          follow.current = latest; setAtLatest(latest);
        }}>
        {session ? <PetSessionTranscript session={session} petName={identity.name} />
          : connection === 'loading' ? <div className="compact-empty">Loading session…</div> : null}
        {session && <p className="pet-session-footnote">Saved history and results come from the session checkpoint. Live tool input and output appear only while observed and are not kept after a reconnect.</p>}
      </div>
      {!atLatest && <button className="channel-jump" type="button" onClick={() => {
        follow.current = true; setAtLatest(true);
        scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'auto' });
      }}>Back to latest ↓</button>}
    </div>
    {review && <PetSessionReview review={review} draft={draft} enabled={connection === 'live'} submission={submission} onChoose={choose} />}
    {!review && submission && (submission.phase === 'error' || submission.phase === 'unknown') && <p className="channel-record-error pet-session-outcome" role="alert">{submission.message}</p>}
  </dialog>;
}
