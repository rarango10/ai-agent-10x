import {
  githubCreateIssue,
  githubCreateRepo,
  githubListIssues,
  githubListRepos,
} from "./github-api";

/**
 * Runs a GitHub tool after user approval (or non-confirming tools during agent run).
 * Used by /api/tool-calls/.../resolve and shared with Telegram.
 */
export async function executeGithubTool(
  toolName: string,
  args: Record<string, unknown>,
  accessToken: string
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case "github_list_repos": {
      const perPage = typeof args.per_page === "number" ? args.per_page : 10;
      const r = await githubListRepos(accessToken, perPage);
      if (!r.ok) return { error: r.message };
      return { message: "Repositories", repos: r.repos };
    }
    case "github_list_issues": {
      const owner = String(args.owner ?? "");
      const repo = String(args.repo ?? "");
      const state = (args.state as "open" | "closed" | "all") ?? "open";
      const r = await githubListIssues(accessToken, owner, repo, state);
      if (!r.ok) return { error: r.message };
      return { message: `Issues for ${owner}/${repo}`, issues: r.issues };
    }
    case "github_create_issue": {
      const owner = String(args.owner ?? "");
      const repo = String(args.repo ?? "");
      const title = String(args.title ?? "");
      const body = String(args.body ?? "");
      const r = await githubCreateIssue(accessToken, owner, repo, title, body);
      if (!r.ok) return { error: r.message };
      return {
        message: "Issue created",
        issue_url: r.issue_url,
        number: r.number,
      };
    }
    case "github_create_repo": {
      const name = String(args.name ?? "");
      const description = String(args.description ?? "");
      const isPrivate = Boolean(args.private);
      const r = await githubCreateRepo(accessToken, name, description, isPrivate);
      if (!r.ok) return { error: r.message };
      return {
        message: "Repository created",
        html_url: r.html_url,
        full_name: r.full_name,
      };
    }
    default:
      return { error: `Unknown GitHub tool: ${toolName}` };
  }
}
