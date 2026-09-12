/** Local-agent owns the Chat Host only. Studio has an independent package entry. */
export const SERVER_MODES = ['chat'] as const;

export type ServerMode = (typeof SERVER_MODES)[number];

export const DEFAULT_SERVER_MODE: ServerMode = 'chat';
