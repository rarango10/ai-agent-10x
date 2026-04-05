import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  encryptOAuthToken,
  upsertIntegration,
} from "@agents/db";

const COOKIE = "gh_oauth_state";

export async function GET(request: Request) {
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const settingsUrl = new URL("/settings", baseUrl);

  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const err = searchParams.get("error");

  if (err) {
    settingsUrl.searchParams.set("github", "error");
    settingsUrl.searchParams.set("reason", err);
    return NextResponse.redirect(settingsUrl);
  }

  if (!code || !state) {
    settingsUrl.searchParams.set("github", "error");
    settingsUrl.searchParams.set("reason", "missing_code");
    return NextResponse.redirect(settingsUrl);
  }

  const cookieStore = await cookies();
  const expected = cookieStore.get(COOKIE)?.value;
  if (!expected || expected !== state) {
    settingsUrl.searchParams.set("github", "error");
    settingsUrl.searchParams.set("reason", "invalid_state");
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.delete(COOKIE);
    return res;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const login = new URL("/login", baseUrl);
    const res = NextResponse.redirect(login);
    res.cookies.delete(COOKIE);
    return res;
  }

  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    settingsUrl.searchParams.set("github", "error");
    settingsUrl.searchParams.set("reason", "server_config");
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.delete(COOKIE);
    return res;
  }

  const redirectUri = `${baseUrl}/api/integrations/github/callback`;
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!tokenRes.ok || !tokenJson.access_token) {
    settingsUrl.searchParams.set("github", "error");
    settingsUrl.searchParams.set(
      "reason",
      tokenJson.error ?? tokenJson.error_description ?? "token_exchange"
    );
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.delete(COOKIE);
    return res;
  }

  const scopes = tokenJson.scope
    ? tokenJson.scope.split(/[\s,]+/).filter(Boolean)
    : ["repo"];

  let encrypted: string;
  try {
    encrypted = encryptOAuthToken(tokenJson.access_token);
  } catch (e) {
    console.error("OAuth encrypt failed:", e);
    settingsUrl.searchParams.set("github", "error");
    settingsUrl.searchParams.set("reason", "encrypt");
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.delete(COOKIE);
    return res;
  }

  const db = createServerClient();
  try {
    await upsertIntegration(db, user.id, "github", scopes, encrypted);
  } catch (e) {
    console.error("upsertIntegration failed:", e);
    settingsUrl.searchParams.set("github", "error");
    settingsUrl.searchParams.set("reason", "db");
    const res = NextResponse.redirect(settingsUrl);
    res.cookies.delete(COOKIE);
    return res;
  }

  settingsUrl.searchParams.set("github", "connected");
  const res = NextResponse.redirect(settingsUrl);
  res.cookies.delete(COOKIE);
  return res;
}
