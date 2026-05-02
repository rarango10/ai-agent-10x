import { CallbackHandler } from "@langfuse/langchain";
import type { LangfuseSpanProcessor as SpanProcessorType } from "@langfuse/otel";

const LANGFUSE_ENABLED =
  !!process.env.LANGFUSE_SECRET_KEY &&
  !!process.env.LANGFUSE_PUBLIC_KEY;

// #region agent log — debug: module-level env check (H2)
console.log("[langfuse:debug] LANGFUSE_ENABLED =", LANGFUSE_ENABLED,
  "| SECRET_KEY set:", !!process.env.LANGFUSE_SECRET_KEY,
  "| PUBLIC_KEY set:", !!process.env.LANGFUSE_PUBLIC_KEY,
  "| BASE_URL:", process.env.LANGFUSE_BASE_URL ?? "(unset)");
// #endregion

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

    // #region agent log — debug: OTel SDK init (H1)
    console.log("[langfuse:debug] Initializing OTel SDK with LangfuseSpanProcessor (exportMode=immediate)");
    // #endregion

    spanProcessor = new LangfuseSpanProcessor({
      exportMode: "immediate",
    });

    const sdk = new NodeSDK({
      spanProcessors: [spanProcessor],
    });
    sdk.start();

    // #region agent log — debug: OTel SDK started (H1)
    console.log("[langfuse:debug] OTel SDK started successfully, spanProcessor ready");
    // #endregion
  } catch (err) {
    // #region agent log — debug: OTel SDK failed (H1)
    console.error("[langfuse:debug] OTel SDK init FAILED:", err);
    // #endregion
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
  // #region agent log — debug: handler creation attempt (H2, H3)
  console.log("[langfuse:debug] createLangfuseHandler called",
    "| LANGFUSE_ENABLED:", LANGFUSE_ENABLED,
    "| sessionId:", opts.sessionId,
    "| userId:", opts.userId);
  // #endregion

  if (!LANGFUSE_ENABLED) return null;

  await ensureOtelSdk();

  const handler = new CallbackHandler({
    sessionId: opts.sessionId,
    userId: opts.userId,
    tags: opts.tags,
  });

  // #region agent log — debug: handler created (H3)
  console.log("[langfuse:debug] CallbackHandler created, last_trace_id:", handler.last_trace_id);
  // #endregion

  return handler;
}

/**
 * Flushes pending Langfuse spans via the OTel SpanProcessor.
 * Call after each graph invocation to guarantee delivery in
 * short-lived / serverless environments.
 */
export async function flushLangfuse(
  _handler: CallbackHandler | null
): Promise<void> {
  // #region agent log — debug: flush attempt (H5)
  console.log("[langfuse:debug] flushLangfuse called",
    "| handler:", !!_handler,
    "| spanProcessor:", !!spanProcessor);
  // #endregion

  if (!_handler || !spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
    // #region agent log — debug: flush success (H5)
    console.log("[langfuse:debug] forceFlush() completed successfully");
    // #endregion
  } catch (err) {
    // #region agent log — debug: flush failed (H5)
    console.error("[langfuse:debug] forceFlush() FAILED:", err);
    // #endregion
  }
}
