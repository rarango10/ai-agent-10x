import { NextResponse } from "next/server";
import {
  createServerClient,
  getDecryptedGithubToken,
  getDueCronJobs,
  getOrCreateSession,
  getTelegramAccountByUserId,
  tryAdvanceCronJobSchedule,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import { sendTelegramMessage } from "@/lib/telegram/send-message";

/** Vercel / serverless: varios jobs en un minuto pueden acercarse al límite por defecto. */
export const maxDuration = 60;

const CRON_SECRET_HEADER = "x-cron-secret";

function mapToolSettings(rows: Record<string, unknown>[] | null) {
  return (rows ?? []).map((t) => ({
    id: t.id as string,
    user_id: t.user_id as string,
    tool_id: t.tool_id as string,
    enabled: t.enabled as boolean,
    config_json: (t.config_json as Record<string, unknown>) ?? {},
  }));
}

function mapIntegrations(rows: Record<string, unknown>[] | null) {
  return (rows ?? []).map((i) => ({
    id: i.id as string,
    user_id: i.user_id as string,
    provider: i.provider as string,
    scopes: (i.scopes as string[]) ?? [],
    status: i.status as "active" | "revoked" | "expired",
    created_at: i.created_at as string,
  }));
}

export async function POST(request: Request) {
  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    console.error("[cron/execute] CRON_SECRET no está definido");
    return NextResponse.json({ error: "Cron not configured" }, { status: 503 });
  }

  const provided = request.headers.get(CRON_SECRET_HEADER);
  if (provided !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  let processed = 0;
  let skipped = 0;

  try {
    const due = await getDueCronJobs(db);

    for (const job of due) {
      const { data: profile } = await db
        .from("profiles")
        .select("agent_system_prompt, timezone")
        .eq("id", job.user_id)
        .single();

      const tz = (profile?.timezone as string | undefined)?.trim() || "UTC";
      const claimed = await tryAdvanceCronJobSchedule(db, job.id, job.expression, tz);
      if (!claimed) {
        skipped++;
        continue;
      }

      const session = await getOrCreateSession(db, job.user_id, "telegram");

      const { data: toolSettings } = await db
        .from("user_tool_settings")
        .select("*")
        .eq("user_id", job.user_id);

      const { data: integrations } = await db
        .from("user_integrations")
        .select("id,user_id,provider,scopes,status,created_at")
        .eq("user_id", job.user_id)
        .eq("status", "active");

      const githubAccessToken = await getDecryptedGithubToken(db, job.user_id);

      const message =
        `[Ejecución programada: "${job.job_name}"]\n\n` + job.description;

      try {
        const result = await runAgent({
          message,
          userId: job.user_id,
          sessionId: session.id,
          systemPrompt:
            (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
          userTimeZone: tz,
          db,
          enabledTools: mapToolSettings(toolSettings as Record<string, unknown>[] | null),
          integrations: mapIntegrations(integrations as Record<string, unknown>[] | null),
          githubAccessToken,
        });

        const tg = await getTelegramAccountByUserId(db, job.user_id);
        if (!tg) {
          console.warn(
            `[cron/execute] Usuario ${job.user_id} sin Telegram vinculado; job ${job.id} ejecutado sin notificación`
          );
          processed++;
          continue;
        }

        if (result.pendingConfirmation) {
          const p = result.pendingConfirmation;
          await sendTelegramMessage(
            tg.chat_id,
            `[Tarea programada] ${job.job_name}\n\n${p.message}`,
            {
              inline_keyboard: [
                [
                  {
                    text: "Aprobar",
                    callback_data: `approve:${p.toolCallId}`,
                  },
                  {
                    text: "Cancelar",
                    callback_data: `reject:${p.toolCallId}`,
                  },
                ],
              ],
            }
          );
        } else {
          const text =
            result.response?.trim() || "(Sin texto de respuesta del agente.)";
          await sendTelegramMessage(
            tg.chat_id,
            `[Tarea programada] ${job.job_name}\n\n${text}`
          );
        }
        processed++;
      } catch (err) {
        console.error(`[cron/execute] Error ejecutando job ${job.id}:`, err);
        const tg = await getTelegramAccountByUserId(db, job.user_id);
        if (tg) {
          await sendTelegramMessage(
            tg.chat_id,
            `[Tarea programada] ${job.job_name}\n\nError: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        processed++;
      }
    }
  } catch (e) {
    console.error("[cron/execute]", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, processed, skipped });
}
