// The cron-alert webhook is a third party /privacidad does not list, so what
// reaches it must carry no personal data (review of 1c1ac9f82, 2026-09-24).
// Callers hand it raw `err.message` strings; this pins that they are scrubbed
// in the summary AND at depth inside `details`. Inputs and expected outputs are
// written out, never derived from the scrubber.

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendCronAlert } from "./cron-alert";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function captureBody(): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }),
  );
  return { bodies };
}

describe("sendCronAlert — nothing personal reaches the webhook", () => {
  it("scrubs an email and a DNI out of the error, the summary and nested details", async () => {
    vi.stubEnv("CRON_ALERT_WEBHOOK", "https://hooks.example.test/alert");
    const { bodies } = captureBody();

    await sendCronAlert({
      job: "case-sweep",
      severity: "critical",
      error: "failed for ana.perez@example.com",
      details: {
        errors: [{ id: "row-1", reason: "dni 30123456 rejected" }],
        processed: 3,
      },
    });

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("ana.perez@example.com");
    expect(serialized).not.toContain("30123456");
    expect(body.error).toBe("failed for [redacted:email]");
    expect(body.text).toBe("[cron-alert:critical] case-sweep — failed for [redacted:email]");
    expect(body.details).toEqual({
      errors: [{ id: "row-1", reason: "dni [redacted:digits] rejected" }],
      processed: 3,
    });
  });

  it("scrubs a DNI passed as a NUMBER and keeps small counters as numbers", async () => {
    vi.stubEnv("CRON_ALERT_WEBHOOK", "https://hooks.example.test/alert");
    const { bodies } = captureBody();

    await sendCronAlert({
      job: "case-sweep",
      details: { dni: 30123456, nested: [{ phone: 1145678901 }], processed: 42, status: 500 },
    });

    const body = bodies[0] as { details: unknown };
    expect(JSON.stringify(body)).not.toContain("30123456");
    expect(body.details).toEqual({
      dni: "[redacted:digits]",
      nested: [{ phone: "[redacted:digits]" }],
      processed: 42,
      status: 500,
    });
  });

  it("stays a no-op without the webhook", async () => {
    vi.stubEnv("CRON_ALERT_WEBHOOK", "");
    const { bodies } = captureBody();
    await sendCronAlert({ job: "case-sweep", error: "x" });
    expect(bodies).toHaveLength(0);
  });
});
