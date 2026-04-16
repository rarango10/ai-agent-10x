import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, getDecryptedGithubToken } from "@agents/db";
import { runAgent } from "@agents/agent";

function chatRouteErrorMessage(error: unknown): { message: string; status: number } {
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const code = e.code;
    const lc = e.lc_error_code;
    const msg =
      typeof e.message === "string"
        ? e.message
        : typeof (e.error as Record<string, unknown>)?.message === "string"
          ? String((e.error as Record<string, unknown>).message)
          : null;
    const raw =
      typeof (e.error as Record<string, unknown>)?.metadata === "object" &&
      (e.error as Record<string, unknown>).metadata !== null
        ? String(
            ((e.error as Record<string, unknown>).metadata as Record<string, unknown>)
              .raw ?? ""
          )
        : "";

    if (code === 429 || lc === "MODEL_RATE_LIMIT") {
      return {
        message:
          raw ||
          msg ||
          "Límite de uso del modelo (429). Los modelos gratuitos en OpenRouter se saturan a menudo; espera unos minutos, prueba otro modelo en OPENROUTER_MODEL o usa un plan de pago.",
        status: 429,
      };
    }
  }
  return { message: "Internal server error", status: 500 };
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { message } = await request.json();
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const db = createServerClient();

    const { data: profile } = await supabase
      .from("profiles")
      .select("agent_system_prompt, agent_name, timezone")
      .eq("id", user.id)
      .single();

    const { data: toolSettings } = await supabase
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", user.id);

    const { data: integrations } = await supabase
      .from("user_integrations")
      .select("id,user_id,provider,scopes,status,created_at")
      .eq("user_id", user.id)
      .eq("status", "active");

    const githubAccessToken = await getDecryptedGithubToken(db, user.id);

    let session = await supabase
      .from("agent_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("channel", "web")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
      .then((r) => r.data);

    if (!session) {
      const { data } = await supabase
        .from("agent_sessions")
        .insert({
          user_id: user.id,
          channel: "web",
          status: "active",
          budget_tokens_used: 0,
          budget_tokens_limit: 100000,
        })
        .select()
        .single();
      session = data;
    }

    if (!session) {
      return NextResponse.json({ error: "Failed to create session" }, { status: 500 });
    }

    const result = await runAgent({
      message,
      userId: user.id,
      sessionId: session.id,
      systemPrompt: (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
      userTimeZone: (profile?.timezone as string) ?? undefined,
      db,
      enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })),
      integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })),
      githubAccessToken,
    });

    const pending = result.pendingConfirmation;

    return NextResponse.json({
      response: pending ? null : result.response,
      pendingConfirmation: pending
        ? {
            toolCallId: pending.toolCallId,
            toolName: pending.toolName,
            message: pending.message,
          }
        : null,
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    const { message, status } = chatRouteErrorMessage(error);
    return NextResponse.json({ error: message }, { status });
  }
}
