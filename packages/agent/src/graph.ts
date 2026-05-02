import { StateGraph, Annotation, Command, interrupt } from "@langchain/langgraph";
import type { StateSnapshot } from "@langchain/langgraph/web";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import {
  createToolCall,
  getProfile,
  getToolCallBySessionAndLcId,
  getSessionMessages,
  addMessage,
  updateToolCallStatus,
} from "@agents/db";
import { buildClockPrefix } from "./time-context";
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import { toolRequiresConfirmation } from "./tools/catalog";
import { executeGithubTool } from "./tools/execute-github-tool";
import {
  ensureLangGraphCheckpointerSetup,
  getLangGraphCheckpointer,
} from "./checkpointer";
import { createLangfuseHandler, flushLangfuse } from "./langfuse";

const INTERRUPT = "__interrupt__" as const;

/** LangGraph default is 25; long threads with tool loops need headroom per invoke. */
const LANGGRAPH_RECURSION_LIMIT = 50;

const TOOL_OUTPUT_FALLBACK_MAX_CHARS = 8000;

export interface PendingConfirmationPayload {
  toolCallId: string;
  toolName: string;
  message: string;
  lcToolCallId?: string;
}

export type HitlInterruptPayload = {
  kind: "tool_confirmation";
  toolCallId: string;
  toolName: string;
  lcToolCallId: string;
  message: string;
};

export type HitlResume =
  | { type: "approve" }
  | { type: "reject"; message?: string };

export interface AgentInput {
  message: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  /** Decrypted GitHub OAuth token; server-only, never sent to the client. */
  githubAccessToken?: string;
  /** IANA timezone from profile; if omitted, loaded from DB (extra query). */
  userTimeZone?: string;
}

export interface ResumeAgentInput
  extends Omit<AgentInput, "message"> {
  resume: HitlResume;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation?: PendingConfirmationPayload;
  interrupted?: boolean;
}

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
});

const MAX_TOOL_ITERATIONS = 6;

/** Max chars stored in tool_calls.result_json for low-risk tools (matches HITL generic path). */
const TOOL_CALL_RESULT_DB_MAX_CHARS = 5000;

function toolCallResultJsonForDb(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const ser = JSON.stringify(parsed);
      if (ser.length <= TOOL_CALL_RESULT_DB_MAX_CHARS) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    /* fall through */
  }
  const truncated = content.length > TOOL_CALL_RESULT_DB_MAX_CHARS;
  return {
    result: content.slice(0, TOOL_CALL_RESULT_DB_MAX_CHARS),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

function hitlUiMessage(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "get_user_preferences") {
    return "Confirma leer tus preferencias y la configuración del agente.";
  }
  if (toolName === "github_create_issue") {
    const title = String(args.title ?? "");
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    return `Confirma crear el issue "${title}" en ${owner}/${repo}.`;
  }
  if (toolName === "github_create_repo") {
    const name = String(args.name ?? "");
    const isPrivate = Boolean(args.private);
    return `Confirma crear el repositorio "${name}"${isPrivate ? " (privado)" : " (público)"}.`;
  }
  if (toolName === "Bash") {
    const terminal = String(args.terminal ?? "");
    const prompt = String(args.prompt ?? "");
    const preview = prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;
    return `Confirma ejecutar Bash en la terminal lógica "${terminal}": ${preview}`;
  }
  if (toolName === "write_file") {
    const terminal = String(args.terminal ?? "");
    const filePath = String(args.path ?? "");
    const content = String(args.content ?? "");
    const approxChars = content.length;
    return `Confirma crear el archivo "${filePath}" (terminal "${terminal}", ~${approxChars} caracteres).`;
  }
  if (toolName === "edit_file") {
    const terminal = String(args.terminal ?? "");
    const filePath = String(args.path ?? "");
    const oldStr = String(args.old_string ?? "");
    const preview = oldStr.length > 80 ? `${oldStr.slice(0, 80)}…` : oldStr;
    return `Confirma editar "${filePath}" (terminal "${terminal}"), reemplazando: ${preview}`;
  }
  return "Confirma esta acción.";
}

function lastHumanMessageIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) return i;
  }
  return -1;
}

function toolCallHasResponse(
  messages: BaseMessage[],
  aiIndex: number,
  toolCallId: string | undefined
): boolean {
  if (!toolCallId) return false;
  // Do not stop at the next AIMessage with tool_calls: later Human/AI turns can sit
  // between this call and its ToolMessage; ids are unique so a full forward scan is safe.
  for (let j = aiIndex + 1; j < messages.length; j++) {
    const m = messages[j];
    if (m instanceof ToolMessage && m.tool_call_id === toolCallId) return true;
  }
  return false;
}

/**
 * Pending tool calls for routing only in the **current user turn** (after the last HumanMessage).
 * Older turns can leave stale AIMessage+tool_calls in checkpoint history; considering them makes
 * routeAfterToolsLow spin on "phantom" pendings and never return to the agent after tools_low.
 */
function findPendingAiMessageWithIndex(
  messages: BaseMessage[]
): { ai: AIMessage; index: number } | null {
  const u = lastHumanMessageIndex(messages);
  for (let i = messages.length - 1; i > u; i--) {
    const msg = messages[i];
    if (!(msg instanceof AIMessage) || !msg.tool_calls?.length) continue;
    for (const tc of msg.tool_calls) {
      if (!toolCallHasResponse(messages, i, tc.id)) {
        return { ai: msg, index: i };
      }
    }
  }
  return null;
}

function isGithubMutatingTool(name: string): boolean {
  return name === "github_create_issue" || name === "github_create_repo";
}

type GraphRuntime = {
  db: DbClient;
  lcTools: ReturnType<typeof buildLangChainTools>;
  modelWithTools: ReturnType<ReturnType<typeof createChatModel>["bindTools"]>;
  githubAccessToken?: string;
  toolCallNames: string[];
};

function createCompiledGraph(runtime: GraphRuntime) {
  const { db, lcTools, modelWithTools, githubAccessToken, toolCallNames } =
    runtime;

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolsLowNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const pending = findPendingAiMessageWithIndex(state.messages);
    if (!pending) return {};

    const { ai, index } = pending;
    const results: ToolMessage[] = [];

    for (const tc of ai.tool_calls ?? []) {
      if (!tc.id || toolCallHasResponse(state.messages, index, tc.id)) continue;
      if (toolRequiresConfirmation(tc.name)) continue;

      let record = await getToolCallBySessionAndLcId(db, state.sessionId, tc.id);
      if (!record) {
        record = await createToolCall(
          db,
          state.sessionId,
          tc.name,
          (tc.args ?? {}) as Record<string, unknown>,
          false,
          tc.id
        );
      }

      const matchingTool = lcTools.find((t) => t.name === tc.name);
      if (!matchingTool) {
        await updateToolCallStatus(db, record.id, "failed", {
          error: "tool_not_available",
          message: `La herramienta "${tc.name}" no está disponible.`,
        });
        results.push(
          new ToolMessage({
            content: JSON.stringify({
              error: `La herramienta "${tc.name}" no está disponible.`,
            }),
            tool_call_id: tc.id,
          })
        );
        toolCallNames.push(tc.name);
        continue;
      }

      toolCallNames.push(tc.name);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (matchingTool as any).invoke(tc.args);
        const resultStr = String(result);
        await updateToolCallStatus(
          db,
          record.id,
          "executed",
          toolCallResultJsonForDb(resultStr)
        );
        results.push(
          new ToolMessage({
            content: resultStr,
            tool_call_id: tc.id,
          })
        );
      } catch (execErr) {
        await updateToolCallStatus(db, record.id, "failed", {
          error: String(execErr),
        });
        results.push(
          new ToolMessage({
            content: JSON.stringify({ error: String(execErr) }),
            tool_call_id: tc.id,
          })
        );
      }
    }

    return results.length ? { messages: results } : {};
  }

  async function toolsHitlNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const pending = findPendingAiMessageWithIndex(state.messages);
    if (!pending) return {};

    const { ai, index } = pending;
    const results: ToolMessage[] = [];

    for (const tc of ai.tool_calls ?? []) {
      if (!tc.id || toolCallHasResponse(state.messages, index, tc.id)) continue;
      if (!toolRequiresConfirmation(tc.name)) continue;

      const lcId = tc.id;
      let record = await getToolCallBySessionAndLcId(
        db,
        state.sessionId,
        lcId
      );
      if (!record) {
        record = await createToolCall(
          db,
          state.sessionId,
          tc.name,
          (tc.args ?? {}) as Record<string, unknown>,
          true,
          lcId
        );
      }

      const interruptPayload: HitlInterruptPayload = {
        kind: "tool_confirmation",
        toolCallId: record.id,
        toolName: tc.name,
        lcToolCallId: lcId,
        message: hitlUiMessage(tc.name, (tc.args ?? {}) as Record<string, unknown>),
      };

      const decision = interrupt(interruptPayload) as HitlResume;

      if (decision.type === "reject") {
        await updateToolCallStatus(db, record.id, "rejected");
        results.push(
          new ToolMessage({
            content:
              decision.message ??
              "El usuario canceló esta acción. No ejecutes la herramienta; responde de forma breve.",
            tool_call_id: tc.id,
            name: tc.name,
          })
        );
        toolCallNames.push(tc.name);
        continue;
      }

      if (isGithubMutatingTool(tc.name)) {
        if (!githubAccessToken) {
          const errMsg = JSON.stringify({
            error:
              "GitHub no está conectado. El usuario debe conectar GitHub en Ajustes.",
          });
          await updateToolCallStatus(db, record.id, "failed", {
            error: "no_github_token",
          });
          results.push(
            new ToolMessage({
              content: errMsg,
              tool_call_id: tc.id,
              name: tc.name,
            })
          );
          toolCallNames.push(tc.name);
          continue;
        }

        const raw = await executeGithubTool(
          tc.name,
          record.arguments_json,
          githubAccessToken
        );
        if ("error" in raw && raw.error) {
          await updateToolCallStatus(db, record.id, "failed", raw);
          results.push(
            new ToolMessage({
              content: JSON.stringify(raw),
              tool_call_id: tc.id,
              name: tc.name,
            })
          );
        } else {
          await updateToolCallStatus(db, record.id, "executed", raw);
          results.push(
            new ToolMessage({
              content: JSON.stringify(raw),
              tool_call_id: tc.id,
              name: tc.name,
            })
          );
        }
        toolCallNames.push(tc.name);
        continue;
      }

      const matchingTool = lcTools.find((t) => t.name === tc.name);
      if (!matchingTool) {
        await updateToolCallStatus(db, record.id, "failed", {
          error: "tool_not_available_after_approve",
        });
        results.push(
          new ToolMessage({
            content: JSON.stringify({
              error: `La herramienta "${tc.name}" no está disponible.`,
            }),
            tool_call_id: tc.id,
            name: tc.name,
          })
        );
        toolCallNames.push(tc.name);
        continue;
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const execResult = await (matchingTool as any).invoke(tc.args ?? {});
        await updateToolCallStatus(db, record.id, "executed", {
          result: String(execResult).slice(0, 5000),
        });
        results.push(
          new ToolMessage({
            content: String(execResult),
            tool_call_id: tc.id,
            name: tc.name,
          })
        );
      } catch (execErr) {
        await updateToolCallStatus(db, record.id, "failed", {
          error: String(execErr),
        });
        results.push(
          new ToolMessage({
            content: JSON.stringify({ error: String(execErr) }),
            tool_call_id: tc.id,
            name: tc.name,
          })
        );
      }
      toolCallNames.push(tc.name);
    }

    return results.length ? { messages: results } : {};
  }

  function shouldContinueFromAgent(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const u = lastHumanMessageIndex(state.messages);
      const iterations = state.messages
        .slice(u + 1)
        .filter((m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length)
        .length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools_low";
    }
    return "end";
  }

  /**
   * After tools_low: if every tool call for the current turn either has a ToolMessage or needs
   * HITL, route to tools_hitl or back to agent. No phantom pendings from pre-turn history.
   */
  function routeAfterToolsLow(state: typeof GraphState.State): string {
    const found = findPendingAiMessageWithIndex(state.messages);
    if (!found) return "agent";
    const { ai, index } = found;
    for (const tc of ai.tool_calls ?? []) {
      if (toolCallHasResponse(state.messages, index, tc.id)) continue;
      if (toolRequiresConfirmation(tc.name)) return "tools_hitl";
      return "tools_low";
    }
    return "agent";
  }

  return new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools_low", toolsLowNode)
    .addNode("tools_hitl", toolsHitlNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinueFromAgent, {
      tools_low: "tools_low",
      end: "__end__",
    })
    .addConditionalEdges("tools_low", routeAfterToolsLow, {
      tools_hitl: "tools_hitl",
      tools_low: "tools_low",
      agent: "agent",
    })
    .addEdge("tools_hitl", "agent")
    .compile({ checkpointer: getLangGraphCheckpointer() });
}

function extractInterruptPayload(
  value: unknown
): HitlInterruptPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.kind !== "tool_confirmation") return undefined;
  if (typeof v.toolCallId !== "string") return undefined;
  if (typeof v.toolName !== "string") return undefined;
  if (typeof v.lcToolCallId !== "string") return undefined;
  if (typeof v.message !== "string") return undefined;
  return v as unknown as HitlInterruptPayload;
}

function readInterruptFromState(state: unknown): HitlInterruptPayload | undefined {
  if (!state || typeof state !== "object") return undefined;
  const rec = state as Record<string, unknown>;
  const intr = rec[INTERRUPT];
  if (!Array.isArray(intr) || intr.length === 0) return undefined;
  const first = intr[0] as { value?: unknown };
  return extractInterruptPayload(first?.value);
}

/**
 * LangGraph often surfaces `interrupt()` on `getState().tasks[].interrupts[].value`, not on
 * `values.__interrupt__`. Without this, HITL rows exist in DB but the API never returns
 * `pendingConfirmation`.
 */
function readInterruptFromSnapshotTasks(
  snap?: StateSnapshot
): HitlInterruptPayload | undefined {
  const tasks = snap?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) return undefined;
  for (const task of tasks) {
    const intrs = task.interrupts;
    if (!Array.isArray(intrs) || intrs.length === 0) continue;
    for (const intr of intrs) {
      const raw =
        intr && typeof intr === "object" && "value" in intr
          ? (intr as { value: unknown }).value
          : intr;
      const payload = extractInterruptPayload(raw);
      if (payload) return payload;
    }
  }
  return undefined;
}

function readInterruptFromInvokeResult(
  result: unknown,
  snap?: StateSnapshot
): HitlInterruptPayload | undefined {
  const fromResult = readInterruptFromState(result);
  if (fromResult) return fromResult;
  if (result && typeof result === "object" && "values" in result) {
    const fromValues = readInterruptFromState(
      (result as { values: unknown }).values
    );
    if (fromValues) return fromValues;
  }
  if (snap?.values) {
    const fromSnapValues = readInterruptFromState(snap.values);
    if (fromSnapValues) return fromSnapValues;
  }
  const fromTasks = readInterruptFromSnapshotTasks(snap);
  if (fromTasks) return fromTasks;
  return undefined;
}

function baseMessageText(m: BaseMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block) {
        return String((block as { text: unknown }).text ?? "");
      }
      return "";
    });
    const joined = parts.join("").trim();
    if (joined) return joined;
  }
  return JSON.stringify(c);
}

/**
 * Prefer the latest assistant text for the current user turn only. Scanning the entire
 * history breaks when the model returns tool-only AI messages (empty string content): the
 * previous walk would skip those and reuse the first non-empty assistant reply (e.g. the greeting).
 */
function lastAssistantReply(messages: BaseMessage[]): string {
  const lastUserIdx = lastHumanMessageIndex(messages);
  for (let i = messages.length - 1; i > lastUserIdx; i--) {
    const m = messages[i];
    if (m instanceof AIMessage) {
      const text = baseMessageText(m);
      if (text.trim()) return text;
    }
  }
  return "";
}

function toolOutputFallbackAfterLastHuman(messages: BaseMessage[]): string {
  const u = lastHumanMessageIndex(messages);
  if (u < 0) return "";
  const chunks: string[] = [];
  for (let i = u + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m instanceof ToolMessage) {
      const raw =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const t = raw.trim();
      if (t) chunks.push(t);
    }
  }
  if (!chunks.length) return "";
  const joined = chunks.join("\n\n");
  const body =
    joined.length > TOOL_OUTPUT_FALLBACK_MAX_CHARS
      ? `${joined.slice(0, TOOL_OUTPUT_FALLBACK_MAX_CHARS)}…`
      : joined;
  return `Resultado de la herramienta:\n\n${body}`;
}

function humanMessageForLlm(clockPrefix: string, userText: string): HumanMessage {
  return new HumanMessage(`${clockPrefix}\n\n${userText}`);
}

async function resolveUserTimeZone(
  input: Pick<AgentInput, "userTimeZone" | "userId" | "db">
): Promise<string> {
  const fromInput = input.userTimeZone?.trim();
  if (fromInput) return fromInput;
  const profile = await getProfile(input.db, input.userId);
  return profile.timezone?.trim() || "UTC";
}

async function buildMessageBatchForInvoke(
  app: {
    getState: (c: {
      configurable: { thread_id: string };
      recursionLimit?: number;
    }) => Promise<StateSnapshot>;
  },
  config: { configurable: { thread_id: string }; recursionLimit?: number },
  input: AgentInput,
  clockPrefix: string
): Promise<BaseMessage[]> {
  let snapshot;
  try {
    snapshot = await app.getState(config);
  } catch {
    snapshot = null;
  }
  const hasCheckpointMessages =
    snapshot &&
    Array.isArray(snapshot.values?.messages) &&
    (snapshot.values.messages as BaseMessage[]).length > 0;

  if (hasCheckpointMessages) {
    return [humanMessageForLlm(clockPrefix, input.message)];
  }

  const history = await getSessionMessages(input.db, input.sessionId, 30);
  const priorRows = history.slice(0, -1);
  const priorMessages: BaseMessage[] = priorRows.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });

  return [
    new SystemMessage(input.systemPrompt),
    ...priorMessages,
    humanMessageForLlm(clockPrefix, input.message),
  ];
}

function outputFromFinalState(
  finalState: unknown,
  toolCallNames: string[],
  snap?: StateSnapshot
): Omit<AgentOutput, "pendingConfirmation" | "interrupted"> & {
  pendingConfirmation?: PendingConfirmationPayload;
  interrupted?: boolean;
} {
  const pending = readInterruptFromInvokeResult(finalState, snap);
  if (pending) {
    return {
      response: "",
      toolCalls: toolCallNames,
      pendingConfirmation: {
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        message: pending.message,
        lcToolCallId: pending.lcToolCallId,
      },
      interrupted: true,
    };
  }

  let messages: BaseMessage[] | undefined;
  if (finalState && typeof finalState === "object") {
    const fs = finalState as Record<string, unknown>;
    if (Array.isArray(fs.messages)) {
      messages = fs.messages as BaseMessage[];
    } else if (
      fs.values &&
      typeof fs.values === "object" &&
      Array.isArray((fs.values as { messages?: BaseMessage[] }).messages)
    ) {
      messages = (fs.values as { messages: BaseMessage[] }).messages;
    }
  }
  if (!messages?.length && snap?.values?.messages) {
    messages = snap.values.messages as BaseMessage[];
  }
  if (!messages?.length) {
    return { response: "", toolCalls: toolCallNames };
  }
  let responseText = lastAssistantReply(messages);
  if (!responseText.trim()) {
    responseText = toolOutputFallbackAfterLastHuman(messages);
  }

  return {
    response: responseText,
    toolCalls: toolCallNames,
  };
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  await ensureLangGraphCheckpointerSetup();

  const {
    message,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubAccessToken,
  } = input;

  const toolCallNames: string[] = [];
  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    githubAccessToken,
  });
  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const app = createCompiledGraph({
    db,
    lcTools,
    modelWithTools,
    githubAccessToken,
    toolCallNames,
  });

  const langfuseHandler = await createLangfuseHandler({ sessionId, userId });

  const config = {
    configurable: { thread_id: sessionId },
    recursionLimit: LANGGRAPH_RECURSION_LIMIT,
    ...(langfuseHandler ? { callbacks: [langfuseHandler] } : {}),
  };

  await addMessage(db, sessionId, "user", message);

  const resolvedTz = await resolveUserTimeZone(input);
  const clockPrefix = buildClockPrefix(resolvedTz);
  const messageBatch = await buildMessageBatchForInvoke(app, config, input, clockPrefix);

  try {
    const finalState = await app.invoke(
      {
        messages: messageBatch,
        sessionId,
        userId,
        systemPrompt,
      },
      config
    );

    const snap = await app.getState(config);
    const out = outputFromFinalState(finalState, toolCallNames, snap);

    if (out.pendingConfirmation) {
      await addMessage(db, sessionId, "assistant", out.pendingConfirmation.message, {
        structured_payload: {
          kind: "hitl_pending",
          toolCallId: out.pendingConfirmation.toolCallId,
          toolName: out.pendingConfirmation.toolName,
          message: out.pendingConfirmation.message,
          lcToolCallId: out.pendingConfirmation.lcToolCallId,
        },
      });
      return {
        response: "",
        toolCalls: out.toolCalls,
        pendingConfirmation: out.pendingConfirmation,
        interrupted: true,
      };
    }

    await addMessage(db, sessionId, "assistant", out.response);
    return {
      response: out.response,
      toolCalls: out.toolCalls,
    };
  } finally {
    await flushLangfuse(langfuseHandler);
  }
}

export async function resumeAgent(input: ResumeAgentInput): Promise<AgentOutput> {
  await ensureLangGraphCheckpointerSetup();

  const {
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubAccessToken,
    resume,
  } = input;

  const toolCallNames: string[] = [];
  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    githubAccessToken,
  });
  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;

  const app = createCompiledGraph({
    db,
    lcTools,
    modelWithTools,
    githubAccessToken,
    toolCallNames,
  });

  const langfuseHandler = await createLangfuseHandler({ sessionId, userId });

  const config = {
    configurable: { thread_id: sessionId },
    recursionLimit: LANGGRAPH_RECURSION_LIMIT,
    ...(langfuseHandler ? { callbacks: [langfuseHandler] } : {}),
  };

  try {
    const finalState = await app.invoke(new Command({ resume }), config);

    const snap = await app.getState(config);
    const out = outputFromFinalState(finalState, toolCallNames, snap);

    if (out.pendingConfirmation) {
      await addMessage(db, sessionId, "assistant", out.pendingConfirmation.message, {
        structured_payload: {
          kind: "hitl_pending",
          toolCallId: out.pendingConfirmation.toolCallId,
          toolName: out.pendingConfirmation.toolName,
          message: out.pendingConfirmation.message,
          lcToolCallId: out.pendingConfirmation.lcToolCallId,
        },
      });
      return {
        response: "",
        toolCalls: out.toolCalls,
        pendingConfirmation: out.pendingConfirmation,
        interrupted: true,
      };
    }

    await addMessage(db, sessionId, "assistant", out.response);
    return {
      response: out.response,
      toolCalls: out.toolCalls,
    };
  } finally {
    await flushLangfuse(langfuseHandler);
  }
}
