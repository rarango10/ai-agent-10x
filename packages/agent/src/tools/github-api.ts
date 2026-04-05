function ghHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubJson<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; message: string; status: number }> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...ghHeaders(token),
      ...(init?.headers as Record<string, string>),
    },
  });
  const text = await res.text();
  let parsed: { message?: string } | T | unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { message: text || res.statusText };
  }
  if (!res.ok) {
    const msg =
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message: string }).message)
        : res.statusText;
    return { ok: false, status: res.status, message: msg };
  }
  return { ok: true, data: parsed as T };
}

export interface GithubRepoSummary {
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
}

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

export async function githubListRepos(
  token: string,
  perPage: number
): Promise<{ ok: true; repos: GithubRepoSummary[] } | { ok: false; message: string }> {
  const safe = Math.min(Math.max(1, perPage), 30);
  const r = await githubJson<GithubRepoSummary[]>(
    token,
    `/user/repos?per_page=${safe}&sort=updated&type=all`
  );
  if (!r.ok) return { ok: false, message: r.message };
  return {
    ok: true,
    repos: r.data.map((repo) => ({
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      html_url: repo.html_url,
      description: repo.description,
    })),
  };
}

export async function githubListIssues(
  token: string,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all"
): Promise<{ ok: true; issues: GithubIssueSummary[] } | { ok: false; message: string }> {
  const r = await githubJson<
    Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      pull_request?: unknown;
    }>
  >(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=30`);
  if (!r.ok) return { ok: false, message: r.message };
  const issues = r.data
    .filter((item) => item.pull_request === undefined)
    .map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      html_url: item.html_url,
    }));
  return { ok: true, issues };
}

export async function githubCreateIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string
): Promise<
  { ok: true; issue_url: string; number: number } | { ok: false; message: string }
> {
  const r = await githubJson<{ html_url: string; number: number }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body: body || "" }),
    }
  );
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, issue_url: r.data.html_url, number: r.data.number };
}

export async function githubCreateRepo(
  token: string,
  name: string,
  description: string,
  isPrivate: boolean
): Promise<
  { ok: true; html_url: string; full_name: string } | { ok: false; message: string }
> {
  const r = await githubJson<{ html_url: string; full_name: string }>(token, "/user/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: description || undefined,
      private: isPrivate,
      auto_init: true,
    }),
  });
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, html_url: r.data.html_url, full_name: r.data.full_name };
}
