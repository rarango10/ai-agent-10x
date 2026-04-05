import { NextResponse } from "next/server";
import {
  createServerClient,
  getDecryptedGithubToken,
  getToolCallById,
  getAgentSessionUserId,
  updateToolCallStatus,
} from "@agents/db";
import { runAgent, executeGithubTool } from "@agents/agent";

const GITHUB_TOOL_NAMES = new Set([
  "github_list_repos",
  "github_list_issues",
  "github_create_issue",
  "github_create_repo",
]);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

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

async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, body);
  }
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

async function answerCallbackQuery(callbackQueryId: string, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

function formatGithubToolResult(
  toolName: string,
  result: Record<string, unknown>
): string {
  if (typeof result.issue_url === "string") {
    return `Issue creado: ${result.issue_url}`;
  }
  if (typeof result.html_url === "string") {
    return `Repositorio creado: ${result.html_url}`;
  }
  return `${toolName}: ${JSON.stringify(result).slice(0, 3500)}`;
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
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
        await answerCallbackQuery(cb.id, "Cuenta no vinculada");
        return NextResponse.json({ ok: true });
      }
      const tc = await getToolCallById(db, toolCallId);
      const sessionUid = tc ? await getAgentSessionUserId(db, tc.session_id) : null;
      if (tc?.status === "pending_confirmation" && sessionUid === linkedUserId) {
        await updateToolCallStatus(db, toolCallId, "rejected");
        await answerCallbackQuery(cb.id, "Rechazado");
        await sendTelegramMessage(cb.message.chat.id, "Acción cancelada.");
      } else {
        await answerCallbackQuery(cb.id, "No aplicable");
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "approve" && toolCallId) {
      if (!linkedUserId) {
        await answerCallbackQuery(cb.id, "Cuenta no vinculada");
        return NextResponse.json({ ok: true });
      }
      const tc = await getToolCallById(db, toolCallId);
      if (!tc || tc.status !== "pending_confirmation") {
        await answerCallbackQuery(cb.id, "Expirado o inválido");
        return NextResponse.json({ ok: true });
      }
      const sessionUid = await getAgentSessionUserId(db, tc.session_id);
      if (sessionUid !== linkedUserId) {
        await answerCallbackQuery(cb.id, "No autorizado");
        return NextResponse.json({ ok: true });
      }
      if (!GITHUB_TOOL_NAMES.has(tc.tool_name)) {
        await answerCallbackQuery(cb.id, "Herramienta no soportada");
        return NextResponse.json({ ok: true });
      }

      const token = await getDecryptedGithubToken(db, linkedUserId);
      if (!token) {
        await answerCallbackQuery(cb.id, "Sin GitHub");
        await sendTelegramMessage(
          cb.message.chat.id,
          "No hay conexión con GitHub o el token no es válido. Conecta GitHub en Ajustes en la web."
        );
        return NextResponse.json({ ok: true });
      }

      await answerCallbackQuery(cb.id, "Aprobado");
      const result = await executeGithubTool(tc.tool_name, tc.arguments_json, token);
      if ("error" in result && result.error) {
        await updateToolCallStatus(db, toolCallId, "failed", result);
        await sendTelegramMessage(
          cb.message.chat.id,
          `Error al ejecutar: ${String(result.error)}`
        );
      } else {
        await updateToolCallStatus(db, toolCallId, "executed", result);
        await sendTelegramMessage(
          cb.message.chat.id,
          formatGithubToolResult(tc.tool_name, result)
        );
      }
      return NextResponse.json({ ok: true });
    }

    await answerCallbackQuery(cb.id, "OK");
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
    .select("agent_system_prompt")
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
      await sendTelegramMessage(chatId, result.response);
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(chatId, "Hubo un error procesando tu mensaje. Intenta de nuevo.");
  }

  return NextResponse.json({ ok: true });
}
