import { spawn } from "node:child_process";
import fs from "node:fs";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

function parseEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Global kill switch for the Bash tool at deploy/infra level (`BASH_TOOL_DISABLED=1`). */
export function isBashToolDisabledByEnv(): boolean {
  return process.env.BASH_TOOL_DISABLED === "1";
}

/**
 * Resolve working directory for a logical terminal name (see plan / user_tool_settings.config_json).
 */
export function resolveBashCwd(
  terminal: string,
  configJson: Record<string, unknown> | undefined
): string {
  const terminals = configJson?.terminals as
    | Record<string, { cwd?: string }>
    | undefined;
  const fromTerm = terminals?.[terminal]?.cwd;
  if (typeof fromTerm === "string" && fromTerm.trim()) {
    return fromTerm.trim();
  }
  const def = configJson?.default_cwd;
  if (typeof def === "string" && def.trim()) {
    return def.trim();
  }
  const envCwd = process.env.BASH_TOOL_DEFAULT_CWD;
  if (envCwd?.trim()) {
    return envCwd.trim();
  }
  return process.cwd();
}

export async function executeBash(args: {
  prompt: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
}): Promise<string> {
  if (isBashToolDisabledByEnv()) {
    return JSON.stringify({
      error:
        "La herramienta Bash está deshabilitada en este entorno (BASH_TOOL_DISABLED=1).",
    });
  }

  const timeoutMs =
    args.timeoutMs ??
    parseEnvInt(process.env.BASH_TOOL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxOutputChars =
    args.maxOutputChars ??
    parseEnvInt(
      process.env.BASH_TOOL_MAX_OUTPUT_CHARS,
      DEFAULT_MAX_OUTPUT_CHARS
    );

  let stat: fs.Stats;
  try {
    stat = fs.statSync(args.cwd);
  } catch {
    return JSON.stringify({
      error: `El directorio de trabajo no existe o no es accesible: ${args.cwd}`,
    });
  }
  if (!stat.isDirectory()) {
    return JSON.stringify({
      error: `La ruta de trabajo no es un directorio: ${args.cwd}`,
    });
  }

  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", args.prompt], {
      cwd: args.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    function appendChunk(chunk: string, target: "stdout" | "stderr") {
      const total = stdout.length + stderr.length;
      if (total >= maxOutputChars) return;
      const room = maxOutputChars - total;
      const piece = chunk.length > room ? chunk.slice(0, room) : chunk;
      if (target === "stdout") stdout += piece;
      else stderr += piece;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => appendChunk(d, "stdout"));
    child.stderr?.on("data", (d: string) => appendChunk(d, "stderr"));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(
        JSON.stringify({
          error: String(err),
          stdout,
          stderr,
          exitCode: null,
        })
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const truncated =
        stdout.length + stderr.length >= maxOutputChars
          ? true
          : undefined;
      resolve(
        JSON.stringify({
          stdout,
          stderr,
          exitCode: code,
          signal: signal ?? undefined,
          ...(timedOut ? { timedOut: true, error: `Timeout after ${timeoutMs}ms` } : {}),
          ...(truncated ? { outputTruncated: true } : {}),
        })
      );
    });
  });
}
