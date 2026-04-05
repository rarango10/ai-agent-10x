import { StateGraph, Annotation, MemorySaver } from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import { getSessionMessages, addMessage } from "@agents/db";

export interface PendingConfirmationPayload {
  toolCallId: string;
  toolName: string;
  message: string;
}

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  haltPendingConfirmation: Annotation<PendingConfirmationPayload | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

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
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation?: PendingConfirmationPayload;
}

const MAX_TOOL_ITERATIONS = 6;

function parsePendingFromToolResult(
  content: string,
  toolName: string
): PendingConfirmationPayload | null {
  try {
    const parsed = JSON.parse(content) as {
      pending_confirmation?: boolean;
      tool_call_id?: string;
      message?: string;
    };
    if (
      parsed.pending_confirmation === true &&
      typeof parsed.tool_call_id === "string"
    ) {
      return {
        toolCallId: parsed.tool_call_id,
        toolName,
        message:
          typeof parsed.message === "string"
            ? parsed.message
            : "Se requiere tu confirmación para continuar.",
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
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

  const history = await getSessionMessages(db, sessionId, 30);
  const priorMessages: BaseMessage[] = history.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });

  await addMessage(db, sessionId, "user", message);

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return { haltPendingConfirmation: null };
    }

    const { ToolMessage } = await import("@langchain/core/messages");
    const results: BaseMessage[] = [];
    let halt: PendingConfirmationPayload | null = null;

    for (const tc of lastMsg.tool_calls) {
      if (halt) break;

      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNames.push(tc.name);
      if (matchingTool) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (matchingTool as any).invoke(tc.args);
        const str = String(result);
        const pending = parsePendingFromToolResult(str, tc.name);
        if (pending) {
          halt = pending;
          results.push(
            new ToolMessage({ content: str, tool_call_id: tc.id! })
          );
          break;
        }
        results.push(
          new ToolMessage({ content: str, tool_call_id: tc.id! })
        );
      }
    }

    return { messages: results, haltPendingConfirmation: halt };
  }

  function shouldContinueFromAgent(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  function shouldContinueFromTools(state: typeof GraphState.State): string {
    if (state.haltPendingConfirmation) return "end";
    return "agent";
  }

  const graph = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinueFromAgent, {
      tools: "tools",
      end: "__end__",
    })
    .addConditionalEdges("tools", shouldContinueFromTools, {
      end: "__end__",
      agent: "agent",
    });

  const checkpointer = new MemorySaver();
  const app = graph.compile({ checkpointer });

  const initialMessages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    ...priorMessages,
    new HumanMessage(message),
  ];

  const finalState = await app.invoke(
    {
      messages: initialMessages,
      sessionId,
      userId,
      systemPrompt,
      haltPendingConfirmation: null,
    },
    { configurable: { thread_id: sessionId } }
  );

  const pending = finalState.haltPendingConfirmation ?? undefined;

  let responseText: string;
  if (pending) {
    responseText = pending.message;
  } else {
    const lastMessage = finalState.messages[finalState.messages.length - 1];
    responseText =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
  }

  await addMessage(db, sessionId, "assistant", responseText);

  return {
    response: pending ? "" : responseText,
    toolCalls: toolCallNames,
    pendingConfirmation: pending,
  };
}
