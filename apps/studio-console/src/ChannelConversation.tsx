import React, { useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChannelDialogFocus } from './channelFocus';
import {
  channelDateKey, channelDeliveryLabel, channelInlineMentionIds, channelMessageIdentity, channelMentionLabel, channelMessagesGroup, channelMessageSummary,
  channelPetSession, type ChannelDelivery, type ChannelMember, type ChannelMessage, type ChannelPet, type ChannelSession,
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

export function ChannelTechnicalDetails({ message }: { message: ChannelMessage }) {
  return <details className="channel-technical"><summary aria-label="Technical details">Details</summary><dl>
    <dt>Message</dt><dd><ChannelCopy label="message ID" value={message.messageId} /></dd>
    <dt>Author</dt><dd>{message.author.kind} · <code>{message.author.id}</code></dd>
    {message.externalRef && <><dt>Source</dt><dd><ChannelCopy label="source message ID" value={message.externalRef} /></dd></>}
  </dl></details>;
}

type MessageMarkdownProps = { body: string; members: ChannelMember[]; viewerParticipantId?: string };

export function ChannelMessageMarkdown({ body, members, viewerParticipantId }: MessageMarkdownProps) {
  return <div className="channel-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}
    urlTransform={url => url.startsWith('participant:') ? url : defaultUrlTransform(url)}
    components={{ a: ({ href, children }) => href?.startsWith('participant:')
      ? <span className="channel-mention">@{channelMentionLabel({ participantId: href.slice('participant:'.length) }, members, viewerParticipantId)}</span>
      : <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{body}</ReactMarkdown></div>;
}

function ChannelMessageViewer({ body, author, occurredAt, members, viewerParticipantId, onClose }: MessageMarkdownProps & {
  author: string; occurredAt: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useChannelDialogFocus(true, dialog, onClose);
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    const root = document.documentElement;
    const overflow = root.style.overflow;
    const position = { x: window.scrollX, y: window.scrollY };
    root.style.overflow = 'hidden';
    element.showModal();
    return () => {
      element.close();
      root.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
      window.scrollTo(position.x, position.y);
    };
  }, []);
  return <dialog ref={dialog} className="channel-message-viewer" aria-labelledby="channel-message-viewer-title"
    aria-describedby="channel-message-viewer-description" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="channel-message-viewer-head">
      <div><h2 id="channel-message-viewer-title">Message from {author}</h2>
        <p id="channel-message-viewer-description">Snapshot when opened · <time dateTime={occurredAt}>{new Date(occurredAt).toLocaleString()}</time></p></div>
      <button type="button" autoFocus onClick={onClose} aria-label="Close full-screen message">Close <span aria-hidden="true">×</span></button>
    </header>
    <div className="channel-message-viewer-scroll" tabIndex={0} aria-label="Full message content">
      <ChannelMessageMarkdown body={body} members={members} viewerParticipantId={viewerParticipantId} />
    </div>
  </dialog>;
}

type TimelineProps = {
  messages: ChannelMessage[]; pending: boolean; onReply: (item: ChannelMessage) => void;
  pets?: ChannelPet[]; petsReady?: boolean; connected?: boolean; highlighted?: string;
  onLocateMessage?: (messageId: string) => void;
  members?: ChannelMember[]; viewerParticipantId?: string; onViewerChange?: (open: boolean) => void;
  /** Deliveries observed by this Console; the Host does not store them. */
  deliveries?: ChannelDelivery[];
  sessions?: ChannelSession[]; onViewSession?: (session: ChannelSession) => void;
};

export function ChannelTimeline({ messages, pending, onReply, pets = [], petsReady = true, connected = true, highlighted, onLocateMessage,
  members = [], viewerParticipantId, onViewerChange, deliveries = [], sessions = [], onViewSession }: TimelineProps) {
  const [viewer, setViewer] = useState<(MessageMarkdownProps & { author: string; occurredAt: string }) | null>(null);
  const closeViewer = () => { setViewer(null); onViewerChange?.(false); };
  const byId = new Map(messages.map(item => [item.messageId, item]));
  return <><div className="channel-timeline">{messages.map((item, index) => {
    const previous = messages[index - 1];
    const showDate = !previous || channelDateKey(previous.occurredAt) !== channelDateKey(item.occurredAt);
    const date = new Date(item.occurredAt);
    const separator = showDate && <div className="channel-date"><time dateTime={item.occurredAt}>{date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</time></div>;
    const identity = channelMessageIdentity(item, pets, petsReady, members, viewerParticipantId);
    const grouped = channelMessagesGroup(previous, item);
    const original = item.replyTo ? byId.get(item.replyTo) : undefined;
    const avatar = identity.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
    const outcomes = deliveries.filter(delivery => delivery.channelId === item.channelId && delivery.messageId === item.messageId);
    const session = item.author.kind === 'pet' ? channelPetSession(item.author.id, sessions) : undefined;
    // Inline @ links already show in the body; only list addressed members the body does not show.
    const inline = channelInlineMentionIds(item.body);
    const extraMentions = item.mentions.filter(mention => !inline.has(mention.participantId));
    return <React.Fragment key={item.messageId}>{separator}<article id={'message-' + item.messageId} tabIndex={-1}
      className={'channel-message' + (grouped ? ' grouped' : '') + (highlighted === item.messageId ? ' located' : '')}
      data-message-id={item.messageId} aria-label={identity.name + ' at ' + date.toLocaleTimeString()}>
      <div className={'channel-avatar ' + item.author.kind} aria-hidden="true">{grouped ? '' : avatar}</div>
      <div className="channel-message-content">
        <div className="channel-message-head">{!grouped && <><strong>{identity.name}</strong>{identity.removed && <span className="channel-removed">Removed Pet</span>}</>}
          <time dateTime={item.occurredAt} title={date.toLocaleString()}>{date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
          {outcomes.filter(delivery => delivery.participantId).map(delivery => <span key={delivery.participantId} className={'channel-inline-state ' + delivery.state}>
            {channelMentionLabel({ participantId: delivery.participantId! }, members, viewerParticipantId)} · {channelDeliveryLabel(delivery)}</span>)}
        </div>
        {item.replyTo && <button className="channel-quote" type="button" onClick={() => onLocateMessage?.(item.replyTo!)}>
          <strong>{original ? channelMessageIdentity(original, pets, petsReady, members, viewerParticipantId).name : 'Referenced message'}</strong><span>{original ? channelMessageSummary(original) : 'Locate the original message'}</span>
        </button>}
        {extraMentions.length > 0 && <div className="channel-mentions" aria-label="Addressed participants">{extraMentions.map((mention, mentionIndex) =>
          <span className="channel-mention" key={mentionIndex}>@{channelMentionLabel(mention, members, viewerParticipantId)}</span>)}</div>}
        <ChannelMessageMarkdown body={item.body} members={members} viewerParticipantId={viewerParticipantId} />
        {outcomes.filter(delivery => delivery.state === 'failed').map((delivery, failureIndex) =>
          <p className="channel-record-error" role="alert" key={failureIndex}>
            {delivery.participantId ? `${channelMentionLabel({ participantId: delivery.participantId }, members, viewerParticipantId)}: ` : 'Mentions were not delivered: '}{delivery.error ?? 'Delivery failed.'}</p>)}
        {item.artifacts.map((artifact, artifactIndex) => <div className="channel-artifact" key={artifactIndex}>
          {/^https?:\/\//i.test(artifact.uri) ? <a href={artifact.uri} target="_blank" rel="noreferrer">{artifact.label ?? artifact.uri}</a> : <code>{artifact.label ?? artifact.uri}</code>}
          {artifact.version && <span> · {artifact.version}</span>}
        </div>)}
        <div className="channel-message-actions" role="toolbar" aria-label={'Message from ' + identity.name}>
          <button type="button" disabled={pending} aria-label={'Reply to ' + identity.name} onClick={() => onReply(item)}>Reply</button>
          {session && onViewSession && <button type="button" disabled={!connected} aria-label={`View ${identity.name} session`} onClick={() => onViewSession(session)}>Session</button>}
          <button type="button" aria-haspopup="dialog" aria-label="View full screen" onClick={() => {
            onViewerChange?.(true);
            setViewer({ body: item.body, author: identity.name, occurredAt: item.occurredAt,
              members: members.map(member => ({ ...member })), viewerParticipantId });
          }}>Full screen</button>
          <ChannelTechnicalDetails message={item} />
        </div>
      </div>
    </article></React.Fragment>;
  })}</div>{viewer && <ChannelMessageViewer {...viewer} onClose={closeViewer} />}</>;
}
