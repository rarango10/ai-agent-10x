import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG } from "./catalog";
import { executeGithubTool } from "./execute-github-tool";
import { executeBash, isBashToolDisabledByEnv, resolveBashCwd } from "./execute-bash";
import { executePing } from "./execute-ping";
import {
  executeEditFile,
  executeReadFile,
  executeWriteFileNewOnly,
  isFileToolsDisabledByEnv,
} from "./filesystem-tools";

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

  if (isToolAvailable("ping", ctx)) {
    tools.push(
      tool(
        async (input) =>
          executePing({
            destination: input.destination,
            count: input.count ?? undefined,
          }),
        {
          name: "ping",
          description:
            "Sends ICMP ping packets to a destination host or IP to verify network connectivity. " +
            "Returns a summary with packet loss and round-trip time statistics.",
          schema: z.object({
            destination: z.string().min(1).describe("Hostname or IP address to ping"),
            count: z
              .number()
              .int()
              .min(1)
              .max(20)
              .optional()
              .describe("Number of packets (default 4, max 20)"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("create_cronjob", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const { createCronJob, getProfile } = await import("@agents/db");
          const { job_name: jobName, description, expression } = input;
          try {
            const profile = await getProfile(ctx.db, ctx.userId);
            const tz = profile.timezone?.trim() || "UTC";
            const row = await createCronJob(
              ctx.db,
              ctx.userId,
              jobName,
              description,
              expression,
              tz
            );
            return JSON.stringify({
              ok: true,
              id: row.id,
              job_name: row.job_name,
              expression: row.expression,
              next_run_at: row.next_run_at,
              timezone: tz,
            });
          } catch (e) {
            return JSON.stringify({
              ok: false,
              error: "cron_create_failed",
              message: e instanceof Error ? e.message : String(e),
            });
          }
        },
        {
          name: "create_cronjob",
          description:
            "Creates a scheduled task (cron job) that will run periodically. " +
            "The task description tells the agent what to do on each execution. " +
            "Uses standard cron expressions (e.g. '0 9 * * 1-5' = weekdays at 9:00 in the user's timezone).",
          schema: z.object({
            job_name: z.string().min(1).describe("Short name for the task"),
            description: z
              .string()
              .min(1)
              .describe("Instructions for what the agent should do on each run"),
            expression: z
              .string()
              .min(1)
              .describe("Cron expression: minute hour day-of-month month day-of-week (5 fields)"),
          }),
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
          const result = await executeGithubTool(
            "github_list_repos",
            input as Record<string, unknown>,
            ctx.githubAccessToken
          );
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
          const result = await executeGithubTool(
            "github_list_issues",
            input as Record<string, unknown>,
            ctx.githubAccessToken
          );
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

  const bashSettingForWorkspace = ctx.enabledTools.find((t) => t.tool_id === "Bash")
    ?.config_json;

  if (isToolAvailable("read_file", ctx) && !isFileToolsDisabledByEnv()) {
    tools.push(
      tool(
        async (input) => {
          const { terminal, path: filePath, offset, limit } = input;
          const result = executeReadFile({
            terminal,
            path: filePath,
            offset: offset ?? undefined,
            limit: limit ?? undefined,
            configJson: bashSettingForWorkspace,
          });
          return JSON.stringify(result);
        },
        {
          name: "read_file",
          description:
            "Read a text file from the user's workspace on the application host. " +
            "When to use: inspect file contents (source, config, docs) under a configured workspace root without shell. " +
            "When NOT to use: to create files (write_file), modify files (edit_file), or paths outside the workspace for `terminal`. " +
            "Parameters: terminal selects workspace root (same as Bash); path is relative; offset optional 1-based start line; limit optional max lines. " +
            "Success: JSON ok=true with line metadata and content. Failure: ok=false with error and code.",
          schema: z.object({
            terminal: z
              .string()
              .describe(
                "Logical terminal id that selects the workspace root (same rules as Bash)."
              ),
            path: z
              .string()
              .describe("File path relative to the workspace root; must not escape the workspace."),
            offset: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe("Optional 1-based start line (default: first line)."),
            limit: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe("Optional max lines to return (defaults and caps apply)."),
          }),
        }
      )
    );
  }

  if (isToolAvailable("write_file", ctx) && !isFileToolsDisabledByEnv()) {
    tools.push(
      tool(
        async (input) => {
          const { terminal, path: filePath, content } = input;
          const result = executeWriteFileNewOnly({
            terminal,
            path: filePath,
            content,
            configJson: bashSettingForWorkspace,
          });
          return JSON.stringify(result);
        },
        {
          name: "write_file",
          description:
            "Create a NEW file inside the user's workspace. NEVER overwrites. " +
            "When to use: a new file that does not exist yet. When NOT: file may exist (use edit_file). " +
            "Requires user confirmation. Success: ok=true, path, bytesWritten.",
          schema: z.object({
            terminal: z.string().describe("Selects workspace root (same as Bash)."),
            path: z
              .string()
              .describe("Relative path from workspace root; must remain inside the workspace."),
            content: z.string().describe("Full file contents to write (text)."),
          }),
        }
      )
    );
  }

  if (isToolAvailable("edit_file", ctx) && !isFileToolsDisabledByEnv()) {
    tools.push(
      tool(
        async (input) => {
          const { terminal, path: filePath, old_string, new_string } = input;
          const result = executeEditFile({
            terminal,
            path: filePath,
            old_string,
            new_string,
            configJson: bashSettingForWorkspace,
          });
          return JSON.stringify(result);
        },
        {
          name: "edit_file",
          description:
            "Edit an EXISTING file: replace exactly ONE occurrence of old_string with new_string. " +
            "When NOT to use: create new files (write_file). Requires confirmation. " +
            "Success: ok=true, replacements=1, sizeBytes.",
          schema: z.object({
            terminal: z.string().describe("Selects workspace root (same as Bash)."),
            path: z
              .string()
              .describe("Relative path from workspace root; file must exist."),
            old_string: z
              .string()
              .describe("Exact substring; must appear exactly once in the file."),
            new_string: z
              .string()
              .describe("Replacement (may be empty to delete the matched segment)."),
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
