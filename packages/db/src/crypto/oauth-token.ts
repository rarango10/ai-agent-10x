import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const VERSION = 1;

/**
 * Loads a 32-byte AES key from OAUTH_ENCRYPTION_KEY.
 * Accepts 64 hex characters or a base64 string that decodes to exactly 32 bytes.
 */
export function loadOAuthEncryptionKey(): Buffer {
  const env = process.env.OAUTH_ENCRYPTION_KEY?.trim();
  if (!env) {
    throw new Error("OAUTH_ENCRYPTION_KEY is required for OAuth token encryption");
  }
  if (/^[0-9a-fA-F]{64}$/.test(env)) {
    return Buffer.from(env, "hex");
  }
  const fromB64 = Buffer.from(env, "base64");
  if (fromB64.length === 32) {
    return fromB64;
  }
  throw new Error(
    "OAUTH_ENCRYPTION_KEY must be 64 hex characters (32 bytes) or base64 encoding 32 bytes. Generate with: openssl rand -hex 32"
  );
}

/** JSON envelope stored in user_integrations.encrypted_tokens */
export function encryptOAuthToken(plaintext: string): string {
  const key = loadOAuthEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ciphertext.toString("base64"),
  });
}

export function decryptOAuthToken(payload: string): string {
  const key = loadOAuthEncryptionKey();
  let parsed: { v: number; iv: string; tag: string; ct: string };
  try {
    parsed = JSON.parse(payload) as { v: number; iv: string; tag: string; ct: string };
  } catch {
    throw new Error("Invalid encrypted token payload");
  }
  if (parsed.v !== VERSION) {
    throw new Error("Unsupported OAuth token encryption version");
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(parsed.iv, "base64"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
