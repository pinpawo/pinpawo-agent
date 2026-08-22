import { readLocalServerToken } from './localHostConnection';

const DEFAULT_LOCAL_SERVER_PORT = 3210;
const DEFAULT_TIMEOUT_MS = 1_500;

export type LocalHostMetadata = {
  localAgentVersion: string | null;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type LoadLocalHostMetadataOptions = {
  port?: number;
  tokenProvider?: () => string | null;
  fetcher?: FetchLike;
  timeoutMs?: number;
};

export async function loadLocalHostMetadata(
  options: LoadLocalHostMetadataOptions = {},
): Promise<LocalHostMetadata> {
  const token = (options.tokenProvider ?? readLocalServerToken)();
  if (!token) {
    return {
      localAgentVersion: null,
    };
  }

  const port = options.port ?? DEFAULT_LOCAL_SERVER_PORT;
  const fetcher = options.fetcher ?? fetch;
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const init = {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    signal: abortController.signal,
  } satisfies RequestInit;

  try {
    const [runtime] = await Promise.allSettled([
      fetchJson(fetcher, `http://127.0.0.1:${port}/runtime`, init),
    ]);
    return {
      localAgentVersion: runtime.status === 'fulfilled'
        ? readOptionalString(runtime.value, 'local_agent_version')
        : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(
  fetcher: FetchLike,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const response = await fetcher(url, init);
  if (!response.ok) {
    throw new Error(`local-agent metadata request failed (${response.status})`);
  }
  return response.json();
}

function readOptionalString(
  value: unknown,
  key: string,
) {
  if (!isRecord(value)) return null;
  const result = value[key];
  return typeof result === 'string' && result.trim()
    ? result.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
