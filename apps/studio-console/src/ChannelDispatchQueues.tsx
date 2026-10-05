import React from 'react';
import { channelPetIdentity, type ChannelGoal, type ChannelPet, type DispatchQueue, type DispatchQueueEntry } from './channelData';

export function ChannelDispatchQueues({ queues, pets, channels, connected, error }: {
  queues: DispatchQueue[]; pets: ChannelPet[]; channels: ChannelGoal[]; connected: boolean; error?: string;
}) {
  const source = (entry: DispatchQueueEntry) => entry.scope?.namespace === 'channel'
    ? channels.find(channel => channel.channelId === entry.scope!.id)?.title ?? 'Other Channel'
    : 'Other session';
  const unknown = !connected || Boolean(error);
  return <section className="channel-global-queues" aria-label="Global Pet status and queues">
    <div className="channel-section-label"><h3>Pets · global activity</h3></div>
    <p className="channel-history-hint">Work across all Channels and sessions.</p>
    {error && <p className="channel-record-error" role="alert">{error}</p>}
    {unknown && <p className="channel-history-hint">Last observed queue; current work is unknown.</p>}
    {queues.map(queue => <article className="channel-queue" key={queue.petId}>
      <div className="channel-execution-head"><strong>{channelPetIdentity(queue.petId, pets).name}</strong>
        <em>{unknown ? 'status unknown' : queue.state === 'open' ? 'available' : queue.state === 'busy' ? 'working' : queue.state === 'waiting' ? 'waiting' : 'blocked'}</em></div>
      {queue.activeDispatch && <p className="channel-active-source">{unknown ? 'Last observed' : 'Working'} · {source(queue.activeDispatch)}</p>}
      {queue.queuedConversations > 0 && <p>Conversation in progress</p>}
      <p>{queue.queuedDispatches} queued</p>
      {(queue.entries?.length ?? 0) > 0 && <ol>{queue.entries!.map(entry => <li key={entry.dispatchId}>
        <span>{source(entry)}</span><time dateTime={entry.enqueuedAt}>{new Date(entry.enqueuedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>
      </li>)}</ol>}
      {queue.queuedDispatches > (queue.entries?.length ?? 0) && <p>Some queue details are unavailable.</p>}
    </article>)}
  </section>;
}
