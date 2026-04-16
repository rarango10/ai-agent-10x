import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "ping",
    name: "ping",
    description:
      "Sends ICMP ping packets to a destination host or IP to verify network connectivity. " +
      "Returns a summary with packet loss and round-trip time statistics.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "Hostname or IP address to ping",
        },
        count: {
          type: "number",
          description: "Number of ping packets to send (default 4, max 20)",
        },
      },
      required: ["destination"],
    },
  },
  {
    id: "create_cronjob",
    name: "create_cronjob",
    description:
      "Creates a scheduled task (cron job) that will run periodically. " +
      "The task description tells the agent what to do on each execution. " +
      "Uses standard cron expressions (e.g. '0 9 * * 1-5' = weekdays at 9:00 in the user's timezone).",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        job_name: { type: "string", description: "Short name for the task" },
        description: {
          type: "string",
          description: "Instructions for what the agent should do on each run",
        },
        expression: {
          type: "string",
          description: "Cron expression: minute hour day-of-month month day-of-week (5 fields)",
        },
      },
      required: ["job_name", "description", "expression"],
    },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Short description" },
        private: { type: "boolean", description: "Whether the repository is private" },
      },
      required: ["name"],
    },
  },
  {
    id: "read_file",
    name: "read_file",
    description:
      "Read a text file from the user's workspace on the application host. " +
      "When to use: inspect file contents (source, config, docs) under a configured workspace root without shell. " +
      "When NOT to use: to create files (write_file), modify files (edit_file), or paths outside the workspace for `terminal`. " +
      "Parameters: terminal selects workspace root (same as Bash: user tool config terminals map, default_cwd, env/process cwd); " +
      "path is relative to that root; offset optional 1-based start line (default 1); limit optional max lines (defaults and caps apply). " +
      "Process: resolve workspace → validate path → read UTF-8 → return line range. " +
      "Success: JSON with ok=true, line metadata, content excerpt. Failure: ok=false, error, stable code.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description:
            "Logical terminal id that selects the workspace root (same rules as Bash).",
        },
        path: {
          type: "string",
          description: "File path relative to the workspace root; must not escape the workspace.",
        },
        offset: {
          type: "number",
          description: "Optional 1-based start line (default: first line).",
        },
        limit: {
          type: "number",
          description: "Optional max lines to return (defaults and caps apply).",
        },
      },
      required: ["terminal", "path"],
    },
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Create a NEW file on the application host inside the user's workspace. NEVER overwrites: if the path exists, fails with an error. " +
      "When to use: user wants a new file that does not exist yet under the workspace root for `terminal`. " +
      "When NOT to use: if the file may exist (use edit_file or read_file first); paths outside workspace. " +
      "Parameters: terminal, path (relative), content (full text). " +
      "After user confirmation (high risk): resolve → reject if exists → mkdir parents if needed → write once. " +
      "Success: ok=true, path, bytesWritten. Failure: ok=false, error, code (e.g. FILE_ALREADY_EXISTS).",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description: "Selects workspace root (same as Bash).",
        },
        path: {
          type: "string",
          description: "Relative path from workspace root; must remain inside the workspace.",
        },
        content: { type: "string", description: "Full file contents to write (text)." },
      },
      required: ["terminal", "path", "content"],
    },
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Edit an EXISTING text file by replacing exactly ONE occurrence of old_string with new_string. " +
      "When to use: file exists and you have a precise excerpt of current contents. " +
      "When NOT to use: create new files (write_file); if unsure of exact text, read_file first. " +
      "old_string must appear exactly once (else NOT_FOUND or AMBIGUOUS_MATCH). new_string may be empty. " +
      "After user confirmation: resolve → read → single replace → write. " +
      "Success: ok=true, path, replacements=1, sizeBytes. Failure: ok=false, error, code.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description: "Selects workspace root (same as Bash).",
        },
        path: {
          type: "string",
          description: "Relative path; file must exist and be a regular file.",
        },
        old_string: {
          type: "string",
          description: "Exact substring to replace; must occur exactly once.",
        },
        new_string: {
          type: "string",
          description: "Replacement text (may be empty to delete the matched segment).",
        },
      },
      required: ["terminal", "path", "old_string", "new_string"],
    },
  },
  {
    id: "Bash",
    name: "Bash",
    description:
      "Use this tool when you need to execute bash commands and interact with the operating system. " +
      "Runs commands in a new shell process on the application host (unix-like) and returns stdout/stderr as text. " +
      "Requires user confirmation. In cloud deployments, commands run on the server, not the end user's machine.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description:
            "Logical terminal/session id used to pick the working directory (see user tool config terminals map).",
        },
        prompt: { type: "string", description: "Bash command or script to run (passed to bash -lc)." },
      },
      required: ["terminal", "prompt"],
    },
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
