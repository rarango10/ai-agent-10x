import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/supabase/server";

const GITHUB_AUTH = "https://github.com/login/oauth/authorize";
const COOKIE = "gh_oauth_state";
const SCOPE = "repo";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"));
  }

  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  if (!clientId) {
    return NextResponse.json(
      { error: "GITHUB_CLIENT_ID is not configured" },
      { status: 500 }
    );
  }

  const redirectUri = `${baseUrl}/api/integrations/github/callback`;
  const state = randomBytes(24).toString("hex");

  const url = new URL(GITHUB_AUTH);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url.toString());
  res.cookies.set(COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return res;
}
