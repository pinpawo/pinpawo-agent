export type CdpRuntimeConfig = Readonly<{
  /** Borrow an existing local Chrome CDP endpoint. Its browser is never closed. */
  endpoint?: string;
  /** Managed Chrome configuration; incompatible with endpoint. */
  executablePath?: string;
  userDataDir?: string;
  headless?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}>;
