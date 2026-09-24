// Cron-failure alerting — the minimum paging surface for the cron fleet
// (review 23 item 2 / Cursor prod-risk #3: a failed legal-window cron or an
// unhealthy fleet must page a human, not just write a `console.warn`).
//
// Transport: an optional generic webhook (`CRON_ALERT_WEBHOOK`). The body is
// shaped to satisfy the three most common sinks at once — Slack (`text`),
// Discord (`content`), and any generic JSON consumer (`job`/`error`/`details`).
//
// Design constraints:
//   - NO-OP GRACEFULLY when the env is unset. A cron must never crash or fail
//     because alerting is unconfigured — reliability code cannot itself be a
//     new failure mode.
//   - BEST-EFFORT. Any error POSTing the webhook is swallowed (logged only):
//     a flaky alert sink must not flip a healthy cron's HTTP status or abort
//     its finalize path.
//   - BOUNDED. A 5s AbortController timeout keeps a hung webhook from eating
//     the cron's wall-clock budget.
//
// Env: set `CRON_ALERT_WEBHOOK` to a Slack/Discord/generic incoming-webhook
// URL to enable paging. Leave it unset to disable (default). Documented in the
// cutover checklist.
//
// EVERY STRING IS SCRUBBED BEFORE IT LEAVES (review of 1c1ac9f82, 2026-09-24).
// The webhook is a third party chosen at deploy time, and /privacidad does not
// list it — so it must not receive personal data. Callers put raw
// `err.message` into `error` and `details.errors[].reason`, and an exception
// message is free text that can interpolate an email, a DNI or a phone. The
// same denylist the client error reporter uses (`lib/observability/redact.ts`)
// is applied to the summary and to every string in `details`, at any depth.
// What remains is job names, counters, reasons and internal row UUIDs. If a
// caller ever needs to send something personal, the answer is to list the
// webhook as a provider on /privacidad first, not to weaken this.

import { redactText } from "@/lib/observability/redact";

export interface CronAlert {
  /** The cron/job name (or `cron-health`) that failed. */
  job: string;
  /** Severity hint for the sink. Defaults to "warning". */
  severity?: "warning" | "critical";
  /** Short human-readable failure reason. */
  error?: string;
  /** Optional structured context (counters, unhealthy list, etc.). */
  details?: Record<string, unknown>;
}

const ALERT_TIMEOUT_MS = 5_000;

/** Every string in `value`, at any depth, through `redactText`. */
function scrubDeep(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  }
  return value;
}

/**
 * Fire a best-effort cron-failure alert. No-ops when `CRON_ALERT_WEBHOOK` is
 * unset. Never throws — a failed alert must not affect the calling cron.
 */
export async function sendCronAlert(alert: CronAlert): Promise<void> {
  const webhook = process.env.CRON_ALERT_WEBHOOK;
  if (!webhook) return; // alerting disabled — graceful no-op

  const severity = alert.severity ?? "warning";
  const error = alert.error === undefined ? null : redactText(alert.error);
  const summary = `[cron-alert:${severity}] ${alert.job} — ${error ?? "unhealthy"}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Slack uses `text`, Discord uses `content`; include both plus the
          // structured fields so a generic consumer has everything.
          text: summary,
          content: summary,
          job: alert.job,
          severity,
          error,
          details: alert.details === undefined ? null : scrubDeep(alert.details),
          at: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // Swallow — alerting is best-effort. Log so the failure is at least visible
    // in the function logs.
    console.error(`[cron-alert] failed to POST alert for job=${alert.job}:`, err);
  }
}
