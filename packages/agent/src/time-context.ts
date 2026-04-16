/**
 * One-line context for the LLM so it can reason about "now" vs scheduled timestamps.
 * Uses IANA timezone (e.g. America/Bogota); invalid values fall back to UTC.
 */
export function buildClockPrefix(ianaTimeZone: string, now: Date = new Date()): string {
  const tz = ianaTimeZone.trim() || "UTC";
  let localPart: string;
  try {
    localPart = new Intl.DateTimeFormat("es", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "long",
    }).format(now);
  } catch {
    localPart = new Intl.DateTimeFormat("es", {
      timeZone: "UTC",
      dateStyle: "full",
      timeStyle: "long",
    }).format(now);
  }
  const utcIso = now.toISOString();
  return `[Contexto del servidor — hora del usuario (${tz}): ${localPart} | instante UTC: ${utcIso}]`;
}
