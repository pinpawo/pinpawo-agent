import { CallbackHandler } from '@langfuse/langchain';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

type LangfuseTraceContext = {
  sessionId?: string;
  userId?: string;
  metadata: Record<string, unknown>;
};

let sdk: NodeSDK | null = null;

function isEnabled(value: string | undefined) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

export function isLangfuseTracingConfigured(env: NodeJS.ProcessEnv = process.env) {
  return isEnabled(env.LANGFUSE_TRACING_ENABLED)
    && Boolean(env.LANGFUSE_BASE_URL?.trim())
    && Boolean(env.LANGFUSE_PUBLIC_KEY?.trim())
    && Boolean(env.LANGFUSE_SECRET_KEY?.trim());
}

function startLangfuseSdk() {
  if (sdk) return;
  sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL,
        environment: process.env.LANGFUSE_TRACING_ENVIRONMENT,
      }),
    ],
  });
  sdk.start();
}

/**
 * One callback per root graph run. LangChain uses it to retain the graph's
 * native parent/child hierarchy for model calls, tools, and parser failures.
 */
export function createLangfuseCallbacks(context: LangfuseTraceContext) {
  if (!isLangfuseTracingConfigured()) return undefined;
  startLangfuseSdk();
  return [new CallbackHandler({
    sessionId: context.sessionId,
    ...(context.userId ? { userId: context.userId } : {}),
    traceMetadata: context.metadata,
  })];
}
