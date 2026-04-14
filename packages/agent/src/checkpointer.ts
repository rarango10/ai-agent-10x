import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

const SCHEMA = "langgraph";

let saver: PostgresSaver | null = null;
/** In-flight or completed setup; cleared on failure so the next request can retry. */
let setupPromise: Promise<void> | null = null;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url?.trim()) {
    throw new Error(
      "DATABASE_URL is required for LangGraph Postgres checkpointer (Supabase: use the direct Postgres connection string)."
    );
  }
  return url.trim();
}

/**
 * Node's `pg` maps `sslmode=require` to strict verify unless `uselibpqcompat=true` is in the URL
 * (see pg-connection-string). That breaks some Supabase pooler setups with SELF_SIGNED_CERT_IN_CHAIN
 * while `psql` with the same URI works. We append the flag unless strict verify is opted in.
 */
function connectionStringForNodePg(): string {
  const raw = requireDatabaseUrl();
  if (process.env.DATABASE_SSL_VERIFY_STRICT === "true") {
    return raw;
  }
  if (/\buselibpqcompat=/i.test(raw) || /\bsslmode=no-verify\b/i.test(raw)) {
    return raw;
  }
  return raw.includes("?") ? `${raw}&uselibpqcompat=true` : `${raw}?uselibpqcompat=true`;
}

/** Shared Postgres checkpointer; graph is compiled per request with this instance. */
export function getLangGraphCheckpointer(): PostgresSaver {
  if (!saver) {
    saver = PostgresSaver.fromConnString(connectionStringForNodePg(), {
      schema: SCHEMA,
    });
  }
  return saver;
}

/**
 * Call once per process while setup succeeds; concurrent callers share the same promise.
 * On failure, state is reset so a later request can retry (e.g. flaky DNS to `db.*.supabase.co`).
 */
export function ensureLangGraphCheckpointerSetup(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getLangGraphCheckpointer()
      .setup()
      .catch((err: unknown) => {
        setupPromise = null;
        saver = null;
        throw err;
      });
  }
  return setupPromise;
}
