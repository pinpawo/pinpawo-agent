import { getConfig } from './config';
import type { ServerMode } from './serverMode';
import {
  resolveModelProfile,
  summarizeModelProfile,
} from './modelProfiles';

export type StartupConfigSnapshot = {
  mode: 'run' | 'tui';
  /** #561 server primary mode; absent for launch surfaces that have no mode. */
  serverMode?: ServerMode;
  workdir: string;
  actorId?: string;
  actorName?: string;
  localServerPort: number;
  localOnlyMode: boolean;
  apiConnected: boolean;
  modelProfileId: string;
  modelProfileFingerprint: string;
  llmModel: string;
  llmEndpointHost: string;
  llmModelPreset: string;
  llmContextWindowTokens: number;
  globalReviewPolicyMode: string;
  browserBackend: string;
  capabilityRegistryBackend: string;
  langsmithTracing: boolean;
  langsmithProject: string;
  langsmithEndpoint: string;
};

function readBooleanEnv(key: string) {
  return process.env[key]?.trim().toLowerCase() === 'true';
}

function readLangSmithTracingEnabled() {
  return [
    'LANGSMITH_TRACING',
    'LANGSMITH_TRACING_V2',
    'LANGCHAIN_TRACING_V2',
    'LANGCHAIN_TRACING',
  ].some(readBooleanEnv);
}

export function buildStartupConfigSnapshot(params: {
  mode: 'run' | 'tui';
  serverMode?: ServerMode;
  workdir: string;
  actorId?: string;
  actorName?: string | null;
}): StartupConfigSnapshot {
  const config = getConfig();
  const profile = resolveModelProfile(
    config.modelProfileRegistry,
    config.modelProfileId,
  );
  return {
    mode: params.mode,
    ...(params.serverMode ? { serverMode: params.serverMode } : {}),
    workdir: params.workdir,
    ...(params.actorId ? { actorId: params.actorId } : {}),
    ...(params.actorName ? { actorName: params.actorName } : {}),
    localServerPort: config.localServerPort,
    localOnlyMode: config.localOnlyMode,
    apiConnected: config.apiConnected,
    modelProfileId: profile.id,
    modelProfileFingerprint: config.modelProfileFingerprint,
    llmModel: profile.model,
    llmEndpointHost: summarizeModelProfile(profile).endpointHost,
    llmModelPreset: profile.sourcePreset ?? 'custom',
    llmContextWindowTokens: profile.contextWindowTokens,
    globalReviewPolicyMode: config.globalReviewPolicyMode,
    browserBackend: config.browserBackend,
    capabilityRegistryBackend: config.capabilityRegistryBackend,
    langsmithTracing: readLangSmithTracingEnabled(),
    langsmithProject: process.env.LANGSMITH_PROJECT?.trim() || '',
    langsmithEndpoint: process.env.LANGSMITH_ENDPOINT?.trim() || '',
  };
}

export function formatStartupConfigSnapshot(snapshot: StartupConfigSnapshot) {
  return [
    '[local-agent] startup config',
    `  mode=${snapshot.mode}`,
    snapshot.serverMode ? `  serverMode=${snapshot.serverMode}` : null,
    `  workdir=${snapshot.workdir}`,
    snapshot.actorId ? `  actorId=${snapshot.actorId}` : null,
    snapshot.actorName ? `  actorName=${snapshot.actorName}` : null,
    `  localServerPort=${snapshot.localServerPort}`,
    `  localOnlyMode=${snapshot.localOnlyMode}`,
    `  apiConnected=${snapshot.apiConnected}`,
    `  modelProfileId=${snapshot.modelProfileId}`,
    `  modelProfileFingerprint=${snapshot.modelProfileFingerprint}`,
    `  llmModel=${snapshot.llmModel}`,
    `  llmEndpointHost=${snapshot.llmEndpointHost}`,
    `  llmModelPreset=${snapshot.llmModelPreset}`,
    `  llmContextWindowTokens=${snapshot.llmContextWindowTokens}`,
    `  globalReviewPolicyMode=${snapshot.globalReviewPolicyMode}`,
    `  browserBackend=${snapshot.browserBackend}`,
    `  capabilityRegistryBackend=${snapshot.capabilityRegistryBackend}`,
    `  langsmithTracing=${snapshot.langsmithTracing}`,
    `  langsmithProject=${snapshot.langsmithProject || 'not configured'}`,
    `  langsmithEndpoint=${snapshot.langsmithEndpoint || 'not configured'}`,
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function logStartupConfig(params: {
  mode: 'run' | 'tui';
  serverMode?: ServerMode;
  workdir: string;
  actorId?: string;
  actorName?: string | null;
}) {
  console.log(formatStartupConfigSnapshot(buildStartupConfigSnapshot(params)));
}
