import type { StudioCliPluginEnvironment } from '@pinpawo/studio';
import { createStudioHttpPlugin as createStudioHttpPluginImpl } from './studioHttpPlugin';

export {
  createStudioHttpPlugin,
  STUDIO_HTTP_ROUTES_HOOK_NAME,
  STUDIO_HTTP_STATIC_HOOK_NAME,
} from './studioHttpPlugin';

/** Explicit module identity consumed by the standalone Studio CLI loader. */
export const id = 'http';

/**
 * CLI factory. Authentication is opt-in; when `authTokenEnv` is set, the token
 * is read from that environment variable rather than studio.json.
 */
export function createStudioPlugin(
  options: Record<string, unknown> | undefined,
  _environment: StudioCliPluginEnvironment,
) {
  const configuredPort = options?.port;
  const configuredTokenEnvironment = options?.authTokenEnv;
  const configuredOrigins = options?.allowedOrigins;
  let port = 4310;
  if (configuredPort !== undefined) {
    if (
      typeof configuredPort !== 'number'
      || !Number.isInteger(configuredPort)
      || configuredPort < 0
      || configuredPort > 65_535
    ) {
      throw new Error('Studio HTTP Plugin option "port" must be an integer from 0 to 65535.');
    }
    port = configuredPort;
  }
  let authTokenEnv: string | undefined;
  if (configuredTokenEnvironment !== undefined) {
    if (typeof configuredTokenEnvironment !== 'string' || !configuredTokenEnvironment.trim()) {
      throw new Error('Studio HTTP Plugin option "authTokenEnv" must be a non-empty string when present.');
    }
    authTokenEnv = configuredTokenEnvironment;
  }
  let allowedOrigins: string[] | undefined;
  if (configuredOrigins !== undefined) {
    if (!Array.isArray(configuredOrigins) || configuredOrigins.some((origin) => typeof origin !== 'string')) {
      throw new Error('Studio HTTP Plugin option "allowedOrigins" must be a string array when present.');
    }
    allowedOrigins = configuredOrigins;
  }
  const unsupported = Object.keys(options ?? {}).filter(
    (key) => key !== 'port' && key !== 'authTokenEnv' && key !== 'allowedOrigins',
  );
  if (unsupported.length > 0) {
    throw new Error(`Studio HTTP Plugin does not support CLI option(s): ${unsupported.join(', ')}.`);
  }
  const authToken = authTokenEnv ? process.env[authTokenEnv] : undefined;
  if (authTokenEnv && !authToken) {
    throw new Error(`Studio HTTP Plugin requires environment variable ${authTokenEnv}.`);
  }
  return createStudioHttpPluginImpl({
    port,
    ...(authToken ? { authToken } : {}),
    ...(allowedOrigins ? { allowedOrigins } : {}),
  });
}
export type {
  CreateStudioHttpPluginOptions,
  StudioHttpDispatchInput,
  StudioHttpDispatchRecord,
  StudioHttpRoute,
  StudioHttpRouteRequest,
  StudioHttpRouteResult,
  StudioHttpRoutesHook,
  StudioHttpStaticAsset,
  StudioHttpStaticHook,
  StudioHttpStaticMount,
  StudioHttpPlugin,
  StudioHttpPluginAddress,
} from './studioHttpPlugin';
