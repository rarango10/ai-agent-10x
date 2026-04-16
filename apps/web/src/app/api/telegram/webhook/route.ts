import { NextResponse } from "next/server";
import {
  createServerClient,
  getDecryptedGithubToken,
  getToolCallById,
  getAgentSessionUserId,
} from "@agents/db";
import { runAgent, resumeAgent } from "@agents/agent";
import {
  answerTelegramCallbackQuery,
  sendTelegramMessage,
} from "@/lib/telegram/send-message";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

/** Vercel / serverless: el agente puede tardar más que el límite por defecto (~10s). */
export const maxDuration = 60;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

/** Telegram sends "/cmd@BotName args" when the user picks a command from the menu. */
function parseBotCommand(messageText: string): { command: string; args: string } {
  const trimmed = messageText.trim();
  const i = trimmed.indexOf(" ");
  const head = i === -1 ? trimmed : trimmed.slice(0, i);
  const tail = i === -1 ? "" : trimmed.slice(i + 1).trim();
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  return { command, args: tail };
}

async function resumeAgentForTelegramSession(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  sessionId: string,
  action: "approve" | "reject"
) {
  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt, timezone")
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("id,user_id,provider,scopes,status,created_at")
    .eq("user_id", userId)
    .eq("status", "active");

  const githubAccessToken = await getDecryptedGithubToken(db, userId);

  return resumeAgent({
    userId,
    sessionId,
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
        : { type: "reject", message: "Acción cancelada desde Telegram." },
  });
}

export async function POST(request: Request) {
  if (!BOT_TOKEN) {
    console.error(
      "[telegram/webhook] TELEGRAM_BOT_TOKEN no está definido; no se puede llamar a la API de Telegram."
    );
    return NextResponse.json({ error: "Bot not configured" }, { status: 503 });
  }

  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    console.warn(
      "[telegram/webhook] Cabecera x-telegram-bot-api-secret-token ausente o incorrecta mientras TELEGRAM_WEBHOOK_SECRET está definido. Vuelve a registrar el webhook con GET /api/telegram/setup (mismo secreto que en .env)."
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await request.json();
  const db = createServerClient();

  // Handle callback queries (confirmation buttons)
  if (update.callback_query) {
    const cb = update.callback_query;
    const [action, toolCallId] = cb.data.split(":");

    const { data: tgAccount } = await db
      .from("telegram_accounts")
      .select("user_id")
      .eq("telegram_user_id", cb.from.id)
      .maybeSingle();

    const linkedUserId = tgAccount?.user_id as string | undefined;

    if (action === "reject" && toolCallId) {
      if (!linkedUserId) {
        await answerTelegramCallbackQuery(cb.id, "Cuenta no vinculada");
        return NextResponse.json({ ok: true });
      }
      const tc = await getToolCallById(db, toolCallId);
      const sessionUid = tc ? await getAgentSessionUserId(db, tc.session_id) : null;
      if (tc?.status === "pending_confirmation" && sessionUid === linkedUserId) {
        await answerTelegramCallbackQuery(cb.id, "Rechazado");
        try {
          const result = await resumeAgentForTelegramSession(
            db,
            linkedUserId,
            tc.session_id,
            "reject"
          );
          const text = result.response?.trim() || "Acción cancelada.";
          await sendTelegramMessage(cb.message.chat.id, text);
        } catch (e) {
          console.error("Telegram resume (reject):", e);
          await sendTelegramMessage(
            cb.message.chat.id,
            "No se pudo completar el rechazo. Prueba en la web."
          );
        }
      } else {
        await answerTelegramCallbackQuery(cb.id, "No aplicable");
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "approve" && toolCallId) {
      if (!linkedUserId) {
        await answerTelegramCallbackQuery(cb.id, "Cuenta no vinculada");
        return NextResponse.json({ ok: true });
      }
      const tc = await getToolCallById(db, toolCallId);
      if (!tc || tc.status !== "pending_confirmation") {
        await answerTelegramCallbackQuery(cb.id, "Expirado o inválido");
        return NextResponse.json({ ok: true });
      }
      const sessionUid = await getAgentSessionUserId(db, tc.session_id);
      if (sessionUid !== linkedUserId) {
        await answerTelegramCallbackQuery(cb.id, "No autorizado");
        return NextResponse.json({ ok: true });
      }

      const token = await getDecryptedGithubToken(db, linkedUserId);
      if (!token) {
        await answerTelegramCallbackQuery(cb.id, "Sin GitHub");
        await sendTelegramMessage(
          cb.message.chat.id,
          "No hay conexión con GitHub o el token no es válido. Conecta GitHub en Ajustes en la web."
        );
        return NextResponse.json({ ok: true });
      }

      await answerTelegramCallbackQuery(cb.id, "Aprobado");
      try {
        const result = await resumeAgentForTelegramSession(
          db,
          linkedUserId,
          tc.session_id,
          "approve"
        );
        if (result.pendingConfirmation) {
          await sendTelegramMessage(cb.message.chat.id, result.pendingConfirmation.message, {
            inline_keyboard: [
              [
                { text: "Aprobar", callback_data: `approve:${result.pendingConfirmation.toolCallId}` },
                { text: "Cancelar", callback_data: `reject:${result.pendingConfirmation.toolCallId}` },
              ],
            ],
          });
        } else {
          const text = result.response?.trim() || "Listo.";
          await sendTelegramMessage(cb.message.chat.id, text);
        }
      } catch (e) {
        console.error("Telegram resume (approve):", e);
        await sendTelegramMessage(
          cb.message.chat.id,
          "No se pudo completar la acción. Prueba en la web."
        );
      }
      return NextResponse.json({ ok: true });
    }

    await answerTelegramCallbackQuery(cb.id, "OK");
    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();
  const { command, args } = parseBotCommand(text);

  // Handle /start (/start@BotName optional)
  if (command === "/start") {
    await sendTelegramMessage(
      chatId,
      "¡Hola! Soy tu agente personal.\n\nSi ya tienes cuenta web, ve a Ajustes → Telegram en la web, genera un código de vinculación y envíamelo así:\n/link TU_CODIGO"
    );
    return NextResponse.json({ ok: true });
  }

  // Handle /link CODE (/link@BotName CODE when chosen from the command list)
  if (command === "/link") {
    const code = args.trim().toUpperCase();
    if (!code) {
      await sendTelegramMessage(
        chatId,
        "Indica el código que generaste en la web, por ejemplo:\n/link ABC123"
      );
      return NextResponse.json({ ok: true });
    }

    const { data: linkRecord } = await db
      .from("telegram_link_codes")
      .select("*")
      .eq("code", code)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!linkRecord) {
      await sendTelegramMessage(chatId, "Código inválido o expirado. Genera uno nuevo desde la web.");
      return NextResponse.json({ ok: true });
    }

    await db.from("telegram_accounts").upsert(
      {
        user_id: linkRecord.user_id,
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        linked_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    await db
      .from("telegram_link_codes")
      .update({ used: true })
      .eq("id", linkRecord.id);

    await sendTelegramMessage(chatId, "¡Cuenta vinculada correctamente! Ya puedes chatear conmigo.");
    return NextResponse.json({ ok: true });
  }

  // Resolve user from telegram_user_id
  const { data: telegramAccount } = await db
    .from("telegram_accounts")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .single();

  if (!telegramAccount) {
    await sendTelegramMessage(
      chatId,
      "No tienes una cuenta vinculada. Usa /link TU_CODIGO (código desde Ajustes en la web)."
    );
    return NextResponse.json({ ok: true });
  }

  const userId = telegramAccount.user_id;

  // Get or create session
  let session = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", "telegram")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
    .then((r) => r.data);

  if (!session) {
    const { data } = await db
      .from("agent_sessions")
      .insert({
        user_id: userId,
        channel: "telegram",
        status: "active",
        budget_tokens_used: 0,
        budget_tokens_limit: 100000,
      })
      .select()
      .single();
    session = data;
  }

  if (!session) {
    await sendTelegramMessage(chatId, "Error interno creando sesión.");
    return NextResponse.json({ ok: true });
  }

  // Load profile, tools, integrations
  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt, timezone")
    .eq("id", userId)
    .single();

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", userId);

  const { data: integrations } = await db
    .from("user_integrations")
    .select("id,user_id,provider,scopes,status,created_at")
    .eq("user_id", userId)
    .eq("status", "active");

  const githubAccessToken = await getDecryptedGithubToken(db, userId);

  try {
    const result = await runAgent({
      message: text,
      userId,
      sessionId: session.id,
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
    });

    if (result.pendingConfirmation) {
      const p = result.pendingConfirmation;
      await sendTelegramMessage(chatId, p.message, {
        inline_keyboard: [
          [
            { text: "Aprobar", callback_data: `approve:${p.toolCallId}` },
            { text: "Cancelar", callback_data: `reject:${p.toolCallId}` },
          ],
        ],
      });
    } else {
      const reply =
        result.response?.trim() ||
        "No recibí una respuesta con texto. Intenta de nuevo o reformula el mensaje.";
      await sendTelegramMessage(chatId, reply);
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
  }

  return NextResponse.json({ ok: true });
}
