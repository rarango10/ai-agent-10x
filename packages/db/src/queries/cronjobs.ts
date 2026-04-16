import CronExpressionParser from "cron-parser";
import type { DbClient } from "../client";
import type { CronJob } from "@agents/types";

/** Small offset so the next slot after a run is strictly after "now" (avoids same-minute duplicates). */
const NEXT_RUN_EPSILON_MS = 1000;

/**
 * Throws if the expression is not a valid cron string for the given IANA timezone.
 */
export function validateCronExpression(expression: string, timeZone = "UTC"): void {
  CronExpressionParser.parse(expression, { currentDate: new Date(), tz: timeZone });
}

export function computeNextRunAt(
  expression: string,
  from: Date,
  timeZone = "UTC"
): Date {
  const expr = CronExpressionParser.parse(expression, {
    currentDate: from,
    tz: timeZone,
  });
  return expr.next().toDate();
}

export async function createCronJob(
  db: DbClient,
  userId: string,
  jobName: string,
  description: string,
  expression: string,
  timeZone = "UTC"
): Promise<CronJob> {
  validateCronExpression(expression, timeZone);
  const next = computeNextRunAt(expression, new Date(), timeZone);
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("cronjobs")
    .insert({
      user_id: userId,
      job_name: jobName,
      description,
      expression,
      enabled: true,
      next_run_at: next.toISOString(),
      updated_at: now,
    })
    .select()
    .single();
  if (error) throw error;
  return data as CronJob;
}

export async function getDueCronJobs(db: DbClient): Promise<CronJob[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("cronjobs")
    .select("*")
    .eq("enabled", true)
    .not("next_run_at", "is", null)
    .lte("next_run_at", nowIso);
  if (error) throw error;
  return (data ?? []) as CronJob[];
}

/**
 * Atomically marks a job as executed and advances `next_run_at` only if it is still due.
 * Prevents double execution when multiple cron workers overlap.
 */
export async function tryAdvanceCronJobSchedule(
  db: DbClient,
  jobId: string,
  expression: string,
  timeZone: string
): Promise<CronJob | null> {
  const now = new Date();
  const fromAfterRun = new Date(now.getTime() + NEXT_RUN_EPSILON_MS);
  const nextRunAt = computeNextRunAt(expression, fromAfterRun, timeZone);
  const nowIso = now.toISOString();
  const { data, error } = await db
    .from("cronjobs")
    .update({
      last_executed_at: nowIso,
      next_run_at: nextRunAt.toISOString(),
      updated_at: nowIso,
    })
    .eq("id", jobId)
    .eq("enabled", true)
    .lte("next_run_at", nowIso)
    .select()
    .maybeSingle();
  if (error) throw error;
  return (data as CronJob | null) ?? null;
}

export async function getUserCronJobs(db: DbClient, userId: string): Promise<CronJob[]> {
  const { data, error } = await db
    .from("cronjobs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CronJob[];
}

export async function deleteCronJob(
  db: DbClient,
  jobId: string,
  userId?: string
): Promise<boolean> {
  let q = db.from("cronjobs").delete().eq("id", jobId);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q.select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function updateCronJobEnabled(
  db: DbClient,
  jobId: string,
  enabled: boolean,
  userId?: string
): Promise<CronJob | null> {
  const now = new Date().toISOString();
  let q = db.from("cronjobs").update({ enabled, updated_at: now }).eq("id", jobId);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q.select().maybeSingle();
  if (error) throw error;
  return (data as CronJob | null) ?? null;
}
