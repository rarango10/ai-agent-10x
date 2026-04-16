import { spawn } from "node:child_process";

const DEFAULT_COUNT = 4;
const MAX_COUNT = 20;
const TIMEOUT_MS = 30_000;
const MAX_RAW_OUTPUT_CHARS = 2_000;

/** Hostname or IPv4-style token; avoids shell metacharacters when passing as argv. */
const DESTINATION_PATTERN = /^[a-zA-Z0-9._-]+$/;

function clampCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return DEFAULT_COUNT;
  const n = Math.floor(count);
  if (n < 1) return 1;
  if (n > MAX_COUNT) return MAX_COUNT;
  return n;
}

function validateDestination(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!DESTINATION_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_RAW_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_RAW_OUTPUT_CHARS)}…`;
}

/**
 * Parses common Linux and macOS `ping` summary lines into numeric fields when present.
 */
function parsePingSummary(stdout: string): {
  packets_sent?: number;
  packets_received?: number;
  packet_loss_percent?: number;
  rtt_min_ms?: number;
  rtt_avg_ms?: number;
  rtt_max_ms?: number;
} {
  const out: ReturnType<typeof parsePingSummary> = {};

  const statsMatch = stdout.match(
    /(\d+)\s+packets?\s+transmitted,\s+(\d+)\s+packets?\s+received,?\s+([\d.]+)%\s+packet\s+loss/i
  );
  if (statsMatch) {
    out.packets_sent = Number.parseInt(statsMatch[1], 10);
    out.packets_received = Number.parseInt(statsMatch[2], 10);
    out.packet_loss_percent = Number.parseFloat(statsMatch[3]);
  }

  const rttMatch = stdout.match(
    /(?:rtt|round-trip)\s+min\/avg\/max(?:\/mdev|\/stddev)?\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/[\d.]+)?\s*ms/i
  );
  if (rttMatch) {
    out.rtt_min_ms = Number.parseFloat(rttMatch[1]);
    out.rtt_avg_ms = Number.parseFloat(rttMatch[2]);
    out.rtt_max_ms = Number.parseFloat(rttMatch[3]);
  }

  return out;
}

export async function executePing(args: {
  destination: string;
  count?: number;
}): Promise<string> {
  const destination = validateDestination(args.destination);
  if (!destination) {
    return JSON.stringify({
      ok: false,
      error: "invalid_destination",
      message:
        "El destino debe ser un hostname o IPv4 válido (solo letras, dígitos, puntos, guiones y guiones bajos).",
    });
  }

  const count = clampCount(args.count);

  return new Promise((resolve) => {
    const child = spawn("ping", ["-c", String(count), destination], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 5_000);
    }, TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr?.on("data", (d: string) => {
      stderr += d;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(
        JSON.stringify({
          ok: false,
          destination,
          count,
          error: "spawn_failed",
          message: String(err),
        })
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const combined = stdout + (stderr ? `\n${stderr}` : "");
      const parsed = parsePingSummary(combined);
      const ok = !timedOut && code === 0;

      resolve(
        JSON.stringify({
          ok,
          destination,
          count,
          exitCode: code,
          signal: signal ?? undefined,
          ...(timedOut ? { timedOut: true, error: `Timeout after ${TIMEOUT_MS}ms` } : {}),
          ...parsed,
          summary:
            parsed.packets_sent !== undefined && parsed.packets_received !== undefined
              ? `${parsed.packets_received}/${parsed.packets_sent} recibidos` +
                (parsed.packet_loss_percent !== undefined
                  ? `, pérdida ${parsed.packet_loss_percent}%`
                  : "") +
                (parsed.rtt_avg_ms !== undefined ? `, RTT medio ${parsed.rtt_avg_ms} ms` : "")
              : undefined,
          raw_output: truncateOutput(combined.trim()),
        })
      );
    });
  });
}
