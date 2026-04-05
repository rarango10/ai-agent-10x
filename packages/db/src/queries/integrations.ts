import type { DbClient } from "../client";
import type { UserIntegration } from "@agents/types";
import { decryptOAuthToken } from "../crypto/oauth-token";

export async function getUserIntegrations(db: DbClient, userId: string) {
  const { data, error } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw error;
  return (data ?? []) as UserIntegration[];
}

export async function upsertIntegration(
  db: DbClient,
  userId: string,
  provider: string,
  scopes: string[],
  encryptedTokens: string
) {
  const { data, error } = await db
    .from("user_integrations")
    .upsert(
      {
        user_id: userId,
        provider,
        scopes,
        encrypted_tokens: encryptedTokens,
        status: "active",
      },
      { onConflict: "user_id,provider" }
    )
    .select()
    .single();
  if (error) throw error;
  return data as UserIntegration;
}

export async function revokeIntegration(
  db: DbClient,
  userId: string,
  provider: string
) {
  const { error } = await db
    .from("user_integrations")
    .update({ status: "revoked" })
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) throw error;
}

/** Service-role only: includes encrypted_tokens for server-side decrypt. */
export async function getActiveGithubIntegrationRow(
  db: DbClient,
  userId: string
) {
  const { data, error } = await db
    .from("user_integrations")
    .select("id, user_id, provider, encrypted_tokens, scopes, status")
    .eq("user_id", userId)
    .eq("provider", "github")
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data as
    | {
        id: string;
        user_id: string;
        provider: string;
        encrypted_tokens: string;
        scopes: string[];
        status: string;
      }
    | null;
}

/** Returns decrypted GitHub OAuth access token, or undefined if missing/invalid. */
export async function getDecryptedGithubToken(
  db: DbClient,
  userId: string
): Promise<string | undefined> {
  const row = await getActiveGithubIntegrationRow(db, userId);
  if (!row?.encrypted_tokens) return undefined;
  try {
    return decryptOAuthToken(row.encrypted_tokens);
  } catch {
    return undefined;
  }
}
