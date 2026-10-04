import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  channelDateKey, channelExecutionOutputs, channelMessageExecution, channelMessageIdentity,
  channelMessagesGroup, channelPetIdentity, channelQuote, executionLabel,
  type ChannelEntry, type ChannelExecution, type ChannelMessage, type ChannelPet,
} from './channelData';

export function ChannelCopy({ label, value }: { label: string; value: string }) {
  const [result, setResult] = useState('');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setResult('Copied');
    } catch { setResult('Select the value to copy'); }
  };
  return <span className="channel-copy"><code>{value}</code><button type="button" aria-label={'Copy ' + label} onClick={() => { void copy(); }}>Copy</button><span role="status">{result}</span></span>;
}

export function ChannelTechnicalDetails({ message, execution }: { message?: ChannelMessage; execution?: ChannelExecution }) {
  return <details className="channel-technical"><summary>Technical details</summary><dl>
    {message && <><dt>Message</dt><dd><ChannelCopy label="message ID" value={message.messageId} /></dd><dt>Author</dt><dd>{message.author.kind} · <code>{message.author.id}</code></dd></>}
    {execution && <><dt>Execution</dt><dd><ChannelCopy label="execution ID" value={execution.executionId} /></dd></>}
    {(message?.source || execution) && <><dt>Pet</dt><dd><code>{message?.source?.petId ?? execution!.petId}</code></dd>
      <dt>Session</dt><dd><ChannelCopy label="session ID" value={message?.source?.sessionId ?? execution!.sessionId} /></dd>
      {(message?.source?.invocationId ?? execution?.invocationId) && <><dt>Invocation</dt><dd><ChannelCopy label="invocation ID" value={(message?.source?.invocationId ?? execution?.invocationId)!} /></dd></>}</>}
  </dl></details>;
}

type TimelineProps = {
  entries: ChannelEntry[]; pending: boolean; onReply: (item: ChannelMessage) => void;
  pets?: ChannelPet[]; petsReady?: boolean; executions?: ChannelExecution[]; connected?: boolean; highlighted?: string;
  onLocateMessage?: (messageId: string) => void; onLocateExecution?: (executionId: string) => void;
};

export function ChannelTimeline({ entries, pending, onReply, pets = [], petsReady = true, executions = [], connected = true,
  highlighted, onLocateMessage, onLocateExecution }: TimelineProps) {
  const messages = new Map(entries.filter((item): item is ChannelMessage => item.kind === 'message').map(item => [item.messageId, item]));
  return <div className="channel-timeline">{entries.map((item, index) => {
    const previous = entries[index - 1];
    const showDate = !previous || channelDateKey(previous.occurredAt) !== channelDateKey(item.occurredAt);
    const date = new Date(item.occurredAt);
    const separator = showDate && <div className="channel-date"><time dateTime={item.occurredAt}>{date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</time></div>;
    if (item.kind === 'revision') return <React.Fragment key={item.sequence}>{separator}<details className="channel-revision">
      <summary>Goal revision · {item.reason} · {date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</summary><p>{item.goal}</p><p>{item.scope}</p>
    </details></React.Fragment>;
    const identity = channelMessageIdentity(item, pets, petsReady);
    const grouped = channelMessagesGroup(previous, item, executions);
    const execution = channelMessageExecution(item, executions);
    const original = item.replyTo ? messages.get(item.replyTo) : undefined;
    const avatar = identity.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
    return <React.Fragment key={item.messageId}>{separator}<article id={'message-' + item.messageId} tabIndex={-1}
      className={'channel-message' + (grouped ? ' grouped' : '') + (highlighted === item.messageId ? ' located' : '')}
      data-message-id={item.messageId} aria-label={identity.name + ' at ' + date.toLocaleTimeString()}>
      <div className={'channel-avatar ' + item.author.kind} aria-hidden="true">{grouped ? '' : avatar}</div>
      <div className="channel-message-content">
        <div className="channel-message-head">{!grouped && <><strong>{identity.name}</strong>{identity.removed && <span className="channel-removed">Removed Pet</span>}</>}
          <time dateTime={item.occurredAt} title={date.toLocaleString()}>{date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
          {execution && <span className={'channel-inline-state ' + execution.state}>{executionLabel(execution, connected)}</span>}
        </div>
        {item.replyTo && <button className="channel-quote" type="button" onClick={() => onLocateMessage?.(item.replyTo!)}>
          <strong>{original ? channelMessageIdentity(original, pets, petsReady).name : 'Referenced message'}</strong><span>{original ? channelQuote(original.body) : 'Locate the original message'}</span>
        </button>}
        <div className="channel-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown></div>
        {item.artifacts.map((artifact, artifactIndex) => <div className="channel-artifact" key={artifactIndex}>
          {/^https?:\/\//i.test(artifact.uri) ? <a href={artifact.uri} target="_blank" rel="noreferrer">{artifact.label ?? artifact.uri}</a> : <code>{artifact.label ?? artifact.uri}</code>}
          {artifact.version && <span> · {artifact.version}</span>}
        </div>)}
        <div className="channel-message-actions">
          {item.source && <button type="button" disabled={pending || identity.removed} title={identity.removed ? 'This Pet is no longer registered on this Host.' : undefined} onClick={() => onReply(item)}>{'Reply to ' + identity.name}</button>}
          {execution && <button type="button" onClick={() => onLocateExecution?.(execution.executionId)}>View execution</button>}
          <ChannelTechnicalDetails message={item} />
        </div>
      </div>
    </article></React.Fragment>;
  })}</div>;
}

export function ChannelExecutionHistory({ executions, connected, pets = [], petsReady = true, entries = [], highlighted, onLocateMessage }: {
  executions: ChannelExecution[]; connected: boolean; pets?: ChannelPet[]; petsReady?: boolean; entries?: ChannelEntry[]; highlighted?: string;
  onLocateMessage?: (messageId: string) => void;
}) {
  return <div className="channel-executions">{!executions.length && <div className="compact-empty">No executions recorded.</div>}{[...executions].reverse().map(item => {
    const identity = channelPetIdentity(item.petId, pets, petsReady);
    const outputs = channelExecutionOutputs(item, entries);
    return <article id={'execution-' + item.executionId} tabIndex={-1} key={item.executionId}
      className={'channel-execution' + (highlighted === item.executionId ? ' located' : '')}>
      <div className="channel-execution-head"><strong>{identity.name}</strong>{identity.removed && <span className="channel-removed">Removed Pet</span>}
        <em className={item.observationLost || (!connected && ['admitting', 'queued', 'running', 'waiting'].includes(item.state)) ? 'unknown' : item.state}>{executionLabel(item, connected)}</em></div>
      <time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString()}</time>
      <div className="channel-execution-links">{item.messageId && <button type="button" onClick={() => onLocateMessage?.(item.messageId!)}>Locate request</button>}
        {outputs.map((output, index) => <button type="button" key={output.messageId} onClick={() => onLocateMessage?.(output.messageId)}>{outputs.length > 1 ? 'Locate output ' + (index + 1) : 'Locate output'}</button>)}</div>
      {(item.observationLost || (!connected && ['admitting', 'queued', 'running', 'waiting'].includes(item.state))) && <p>Observation was interrupted. Last recorded: {item.state}. Refresh and inspect the Pet session; tasks are not replayed automatically.</p>}
      {item.state === 'waiting' && <p>Review was requested. Use the original Pet TUI and session to inspect its current state; this record is not the current approval state.</p>}
      {item.error && <p className="channel-record-error" role="alert">{item.error}</p>}
      {item.deliveryError && <p className="channel-record-error" role="alert">Reply or notice storage failed: {item.deliveryError}</p>}
      <ChannelTechnicalDetails execution={item} />
    </article>;
  })}</div>;
}
