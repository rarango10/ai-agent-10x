import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getToolCallById,
  getAgentSessionUserId,
  getDecryptedGithubToken,
} from "@agents/db";
import { resumeAgent } from "@agents/agent";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: toolCallId } = await context.params;

  let body: { action?: string };
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const tc = await getToolCallById(db, toolCallId);
  if (!tc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sessionUserId = await getAgentSessionUserId(db, tc.session_id);
  if (sessionUserId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (tc.status !== "pending_confirmation") {
    return NextResponse.json(
      { error: "This action is not awaiting confirmation" },
      { status: 400 }
    );
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("agent_system_prompt, timezone")
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

  try {
    const result = await resumeAgent({
      userId: user.id,
      sessionId: tc.session_id,
      systemPrompt: profile?.agent_system_prompt ?? "Eres un asistente útil.",
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
      resume:
        action === "approve"
          ? { type: "approve" }
          : { type: "reject", message: "Acción cancelada por el usuario." },
    });

    if (result.pendingConfirmation) {
      return NextResponse.json({
        ok: true,
        response: null,
        pendingConfirmation: {
          toolCallId: result.pendingConfirmation.toolCallId,
          toolName: result.pendingConfirmation.toolName,
          message: result.pendingConfirmation.message,
        },
        toolCalls: result.toolCalls,
      });
    }

    return NextResponse.json({
      ok: true,
      response: result.response,
      toolCalls: result.toolCalls,
    });
  } catch (e) {
    console.error("resumeAgent error:", e);
    return NextResponse.json(
      { error: "Failed to resume agent run" },
      { status: 500 }
    );
  }
}
