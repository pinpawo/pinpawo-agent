import React from 'react';
import type { DispatchRecord } from './dispatchActivity';
import { channelPetIdentity } from './channelData';

/** Live execution observations, separate from saved messages and admission receipts. */
export function ChannelDispatchFailures({ channelId, dispatches, pets, petsReady }: {
  channelId: string; dispatches: DispatchRecord[]; pets: { petId: string; name: string }[]; petsReady: boolean;
}) {
  return <>{dispatches.filter(item => item.state === 'failed' && item.scope?.namespace === 'channel'
    && item.scope.id === channelId).map(item => <div className="channel-record-error" role="alert" key={item.invocationId}>
      <strong>{channelPetIdentity(item.petId, pets, petsReady).name} execution failed: </strong>{item.error ?? 'Unknown error'}
      {item.diagnostics && <div>{item.diagnostics.chain.map(cause => [cause.name, cause.code,
        cause.status === undefined ? undefined : `HTTP ${cause.status}`].filter(Boolean).join(' · ')).join(' → ')}</div>}
      <small>Invocation: {item.invocationId}{item.requestId ? ` · Request: ${item.requestId}` : ''}{item.sessionId ? ` · Session: ${item.sessionId}` : ''}</small>
    </div>)}</>;
}
