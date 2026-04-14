import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";
import { executeGithubTool } from "./execute-github-tool";
import { executeBash, isBashToolDisabledByEnv, resolveBashCwd } from "./execute-bash";

interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubAccessToken?: string;
}

function githubDisconnectedMessage(): string {
  return JSON.stringify({
    error:
      "GitHub no está conectado. Conecta tu cuenta en Ajustes para usar herramientas de GitHub.",
  });
}

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          });
        },
        {
          name: "get_user_preferences",
          description: "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id);
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.githubAccessToken) {
            return githubDisconnectedMessage();
          }
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "github_list_repos",
            input as Record<string, unknown>,
            false
          );
          const result = await executeGithubTool(
            "github_list_repos",
            input as Record<string, unknown>,
            ctx.githubAccessToken
          );
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: z.object({
            per_page: z.number().max(30).nullish().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => {
          if (!ctx.githubAccessToken) {
            return githubDisconnectedMessage();
          }
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "github_list_issues",
            input as Record<string, unknown>,
            false
          );
          const result = await executeGithubTool(
            "github_list_issues",
            input as Record<string, unknown>,
            ctx.githubAccessToken
          );
          await updateToolCallStatus(ctx.db, record.id, "executed", result);
          return JSON.stringify(result);
        },
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z.enum(["open", "closed", "all"]).nullish().default("open"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async () => {
          if (!ctx.githubAccessToken) {
            return githubDisconnectedMessage();
          }
          return JSON.stringify({
            pending_hitl:
              "Esta acción se ejecuta solo tras confirmación en el flujo del agente.",
          });
        },
        {
          name: "github_create_issue",
          description: "Creates a new issue in a GitHub repository. Requires confirmation.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().nullish().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async () => {
          if (!ctx.githubAccessToken) {
            return githubDisconnectedMessage();
          }
          return JSON.stringify({
            pending_hitl:
              "Esta acción se ejecuta solo tras confirmación en el flujo del agente.",
          });
        },
        {
          name: "github_create_repo",
          description: "Creates a new GitHub repository for the user. Requires confirmation.",
          schema: z.object({
            name: z.string(),
            description: z.string().nullish().default(""),
            private: z.boolean().nullish().default(false),
          }),
        }
      )
    );
  }

  if (isToolAvailable("Bash", ctx) && !isBashToolDisabledByEnv()) {
    const bashSetting = ctx.enabledTools.find((t) => t.tool_id === "Bash");
    tools.push(
      tool(
        async ({ terminal, prompt }) => {
          const cwd = resolveBashCwd(terminal, bashSetting?.config_json);
          return executeBash({ prompt, cwd });
        },
        {
          name: "Bash",
          description:
            "Use this tool when you need to execute bash commands and interact with the operating system. " +
            "Runs commands in a new shell process on the application host (unix-like) and returns stdout/stderr as text. " +
            "Requires user confirmation. In cloud deployments, commands run on the server, not the end user's machine.",
          schema: z.object({
            terminal: z
              .string()
              .describe(
                "Logical terminal/session id used to pick the working directory (see user tool config)."
              ),
            prompt: z.string().describe("Bash command or script to run (passed to bash -lc)."),
          }),
        }
      )
    );
  }

  return tools;
}
