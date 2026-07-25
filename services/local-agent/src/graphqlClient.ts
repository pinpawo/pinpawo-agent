import { getConfig } from './config';

type GqlResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

function checkJwtExpiry() {
  const config = getConfig();
  try {
    const payload = config.hasuraJwt.split('.')[1];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const exp = decoded.exp as number | undefined;
    if (!exp) return;
    const secsLeft = exp - Math.floor(Date.now() / 1000);
    if (secsLeft < 0) {
      throw new Error('hasura_jwt has expired — run "pinpawo login" to refresh credentials');
    }
    if (secsLeft < 7 * 24 * 3600) {
      console.warn(`[auth] hasura_jwt expires in ${Math.ceil(secsLeft / 86400)} days — consider re-running "pinpawo login"`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('expired')) throw e;
  }
}

export async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const config = getConfig();
  if (!config.apiConnected) {
    throw new Error(`${config.apiSetupMessage || 'API login is not configured.'}`);
  }
  checkJwtExpiry();
  const res = await fetch(config.hasuraEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.hasuraJwt}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();

  if (!res.ok || !text) {
    throw new Error(`GraphQL HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let json: GqlResponse<T>;
  try {
    json = JSON.parse(text) as GqlResponse<T>;
  } catch {
    throw new Error(`GraphQL: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }

  if (json.errors?.length) {
    throw new Error(`GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }
  if (!json.data) {
    throw new Error(`GraphQL: empty response (${res.status}): ${text.slice(0, 200)}`);
  }

  return json.data;
}
