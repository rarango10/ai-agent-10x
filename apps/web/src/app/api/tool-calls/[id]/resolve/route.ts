import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getToolCallById,
  getAgentSessionUserId,
  getDecryptedGithubToken,
  updateToolCallStatus,
} from "@agents/db";
import { executeGithubTool } from "@agents/agent";

const GITHUB_TOOL_NAMES = new Set([
  "github_list_repos",
  "github_list_issues",
  "github_create_issue",
  "github_create_repo",
]);

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

  if (action === "reject") {
    await updateToolCallStatus(db, toolCallId, "rejected");
    return NextResponse.json({ ok: true });
  }

  if (!GITHUB_TOOL_NAMES.has(tc.tool_name)) {
    return NextResponse.json({ error: "Unsupported tool" }, { status: 400 });
  }

  const token = await getDecryptedGithubToken(db, user.id);
  if (!token) {
    return NextResponse.json(
      { error: "GitHub is not connected or token could not be decrypted" },
      { status: 400 }
    );
  }

  const result = await executeGithubTool(tc.tool_name, tc.arguments_json, token);

  if ("error" in result && result.error) {
    await updateToolCallStatus(db, toolCallId, "failed", result);
    return NextResponse.json(
      { ok: false, error: String(result.error) },
      { status: 200 }
    );
  }

  await updateToolCallStatus(db, toolCallId, "executed", result);
  return NextResponse.json({ ok: true, result });
}
