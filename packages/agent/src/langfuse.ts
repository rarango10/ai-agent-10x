import { CallbackHandler } from "@langfuse/langchain";
import type { LangfuseSpanProcessor as SpanProcessorType } from "@langfuse/otel";

const LANGFUSE_ENABLED =
  !!process.env.LANGFUSE_SECRET_KEY &&
  !!process.env.LANGFUSE_PUBLIC_KEY;

let otelInitialized = false;
let spanProcessor: SpanProcessorType | null = null;

/**
 * Starts the OpenTelemetry SDK with the Langfuse span processor.
 * Must run once before any CallbackHandler is created so that the
 * OTel spans the handler emits are actually sent to Langfuse.
 */
async function ensureOtelSdk(): Promise<void> {
  if (otelInitialized || !LANGFUSE_ENABLED) return;
  otelInitialized = true;

  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { LangfuseSpanProcessor } = await import("@langfuse/otel");

    spanProcessor = new LangfuseSpanProcessor({
      exportMode: "immediate",
    });

    const sdk = new NodeSDK({
      spanProcessors: [spanProcessor],
    });
    sdk.start();
  } catch (err) {
    console.warn("[langfuse] Failed to initialize OTel SDK:", err);
  }
}

export interface LangfuseTraceOptions {
  sessionId: string;
  userId: string;
  tags?: string[];
}

/**
 * Creates a Langfuse CallbackHandler scoped to a single agent invocation.
 * Returns `null` when Langfuse is not configured so callers can skip it.
 */
export async function createLangfuseHandler(
  opts: LangfuseTraceOptions
): Promise<CallbackHandler | null> {
  if (!LANGFUSE_ENABLED) return null;

  await ensureOtelSdk();

  return new CallbackHandler({
    sessionId: opts.sessionId,
    userId: opts.userId,
    tags: opts.tags,
  });
}

/**
 * Flushes pending Langfuse spans via the OTel SpanProcessor.
 * Call after each graph invocation to guarantee delivery in
 * short-lived / serverless environments.
 */
export async function flushLangfuse(
  _handler: CallbackHandler | null
): Promise<void> {
  if (!_handler || !spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch {
    /* best-effort: tracing failure must never break the agent */
  }
}
