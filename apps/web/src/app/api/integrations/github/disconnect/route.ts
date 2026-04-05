import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  decryptOAuthToken,
  getActiveGithubIntegrationRow,
  revokeIntegration,
} from "@agents/db";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();
  const row = await getActiveGithubIntegrationRow(db, user.id);

  if (row?.encrypted_tokens) {
    try {
      const accessToken = decryptOAuthToken(row.encrypted_tokens);
      const clientId = process.env.GITHUB_CLIENT_ID?.trim();
      const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
      if (clientId && clientSecret) {
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        await fetch(`https://api.github.com/applications/${clientId}/grant`, {
          method: "DELETE",
          headers: {
            Authorization: `Basic ${basic}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ access_token: accessToken }),
        }).catch(() => {
          /* best-effort revoke */
        });
      }
    } catch {
      /* still revoke locally */
    }
  }

  await revokeIntegration(db, user.id, "github");
  return NextResponse.json({ ok: true });
}
