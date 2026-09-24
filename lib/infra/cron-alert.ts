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

/**
 * Fire a best-effort cron-failure alert. No-ops when `CRON_ALERT_WEBHOOK` is
 * unset. Never throws — a failed alert must not affect the calling cron.
 */
export async function sendCronAlert(alert: CronAlert): Promise<void> {
  const webhook = process.env.CRON_ALERT_WEBHOOK;
  if (!webhook) return; // alerting disabled — graceful no-op

  const severity = alert.severity ?? "warning";
  const summary = `[cron-alert:${severity}] ${alert.job} — ${alert.error ?? "unhealthy"}`;

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
          error: alert.error ?? null,
          details: alert.details ?? null,
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
