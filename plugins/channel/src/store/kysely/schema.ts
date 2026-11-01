import type { Generated } from 'kysely';
import type { MemberRef } from '../channelStore';

/** The Channel Plugin's tables in the Studio database. */
export type ChannelDatabase = {
  channels: {
    seq: Generated<number>;
    channel_id: string;
    title: string;
    description: string | null;
    prompt: string | null;
    created_by_kind: MemberRef['kind'];
    created_by_id: string;
    created_at: string;
    updated_at: string;
  };
  channel_members: {
    channel_id: string;
    member_kind: MemberRef['kind'];
    member_id: string;
    joined_at: string;
    left_at: string | null;
  };
  channel_messages: {
    sequence: Generated<number>;
    message_id: string;
    channel_id: string;
    author_kind: MemberRef['kind'];
    author_id: string;
    occurred_at: string;
    external_ref: string | null;
    /** body, replyTo, mentions and artifacts, as JSON text. */
    data: string;
  };
  channel_sessions: {
    channel_id: string;
    pet_id: string;
    session_id: string;
    registered: number;
  };
};
