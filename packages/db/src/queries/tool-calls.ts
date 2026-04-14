import type { DbClient } from "../client";
import type { ToolCall } from "@agents/types";

export async function createToolCall(
  db: DbClient,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requiresConfirmation: boolean,
  lcToolCallId?: string
) {
  const { data, error } = await db
    .from("tool_calls")
    .insert({
      session_id: sessionId,
      tool_name: toolName,
      arguments_json: args,
      status: requiresConfirmation ? "pending_confirmation" : "approved",
      requires_confirmation: requiresConfirmation,
      ...(lcToolCallId ? { lc_tool_call_id: lcToolCallId } : {}),
    })
    .select()
    .single();
  if (error) throw error;
  return data as ToolCall;
}

export async function getToolCallBySessionAndLcId(
  db: DbClient,
  sessionId: string,
  lcToolCallId: string
): Promise<ToolCall | null> {
  const { data, error } = await db
    .from("tool_calls")
    .select("*")
    .eq("session_id", sessionId)
    .eq("lc_tool_call_id", lcToolCallId)
    .maybeSingle();
  if (error) throw error;
  return data as ToolCall | null;
}

export async function updateToolCallStatus(
  db: DbClient,
  toolCallId: string,
  status: ToolCall["status"],
  resultJson?: Record<string, unknown>
) {
  const update: Record<string, unknown> = { status };
  if (resultJson) update.result_json = resultJson;
  if (status === "executed" || status === "failed") {
    update.finished_at = new Date().toISOString();
  }
  const { error } = await db
    .from("tool_calls")
    .update(update)
    .eq("id", toolCallId);
  if (error) throw error;
}

export async function getPendingToolCall(db: DbClient, toolCallId: string) {
  const { data } = await db
    .from("tool_calls")
    .select("*")
    .eq("id", toolCallId)
    .eq("status", "pending_confirmation")
    .single();
  return data as ToolCall | null;
}

export async function getToolCallById(db: DbClient, toolCallId: string) {
  const { data, error } = await db
    .from("tool_calls")
    .select("*")
    .eq("id", toolCallId)
    .maybeSingle();
  if (error) throw error;
  return data as ToolCall | null;
}

export async function getAgentSessionUserId(
  db: DbClient,
  sessionId: string
): Promise<string | null> {
  const { data, error } = await db
    .from("agent_sessions")
    .select("user_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  return (data as { user_id: string } | null)?.user_id ?? null;
}
