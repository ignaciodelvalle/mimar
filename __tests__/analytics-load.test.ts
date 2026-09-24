// WP4 / D2 — loadWithTimeout: bounded loading for admin analytics pages.

import { afterEach, describe, expect, it } from "vitest";

import {
  type AnalyticsLoad,
  analyticsRetryHref,
  loadWithTimeout,
} from "@/lib/analytics/analytics-load";
import {
  type ErrorSink,
  type RedactedErrorReport,
  resetErrorSink,
  setErrorSink,
} from "@/lib/observability/sink";

const tick = (ms: number, value: unknown) =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

/**
 * Captures what `loadWithTimeout` reports, through the real sink seam.
 *
 * These two tests used to spy on `console.error` and cast its second argument
 * to a hand-written `{ message, correlationId, source }`. Both halves of that
 * were load-bearing in the wrong direction:
 *
 * - the CAST asserted a shape the reporter never promised, so when
 *   `buildErrorReport` moved caller context down under `context`, `tsc` stayed
 *   silent and the drift surfaced only at runtime, as
 *   `expected undefined to be '214851b2'`;
 * - the SPY pinned `consoleSink`'s exact console call, which is that sink's
 *   business and is already covered by `lib/observability/sink.test.ts`.
 *
 * Reading the sink's own `RedactedErrorReport` puts the contract back under the
 * compiler: `report.correlationId` is now a compile error rather than a silent
 * `undefined`, so the next field that moves stops this file from building
 * instead of letting it go quietly red.
 */
function captureReports(): RedactedErrorReport[] {
  const received: RedactedErrorReport[] = [];
  const sink: ErrorSink = { name: "test-capture", send: (r) => received.push(r) };
  setErrorSink(sink);
  return received;
}

afterEach(() => {
  resetErrorSink();
});

describe("loadWithTimeout()", () => {
  it("returns the value when the promise settles before the deadline", async () => {
    const res = await loadWithTimeout(Promise.resolve(42), 1000);
    expect(res).toEqual<AnalyticsLoad<number>>({ ok: true, value: 42 });
  });

  it("returns reason 'timeout' + a correlation id when the deadline wins", async () => {
    // A promise that resolves AFTER the deadline → timeout wins.
    const res = await loadWithTimeout(tick(200, "late"), 20);
    expect(res).toMatchObject({ ok: false, reason: "timeout" });
    if (!res.ok) expect(res.id).toMatch(/^[a-z0-9]{8}$/);
  });

  it("returns reason 'error' + a correlation id when the promise rejects", async () => {
    const res = await loadWithTimeout(Promise.reject(new Error("boom")), 1000);
    expect(res).toMatchObject({ ok: false, reason: "error" });
    if (!res.ok) expect(res.id).toMatch(/^[a-z0-9]{8}$/);
  });

  it("reports the real error tagged with the SAME id the caller gets (QA fix 6)", async () => {
    const received = captureReports();

    const res = await loadWithTimeout(Promise.reject(new Error("boom-real")), 1000);

    expect(res.ok).toBe(false);
    const id = res.ok ? undefined : res.id;
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe("boom-real");
    // Caller context lives under `context` — the whole point of the nesting is
    // that these two fields are the CALLER's, scrubbed by the allowlist, while
    // `message` above is the ERROR's, scrubbed by the free-text denylist.
    expect(received[0].context.correlationId).toBe(id);
    expect(received[0].context.source).toBe("loadWithTimeout");
  });

  it("does not double-log when the abandoned promise rejects AFTER the deadline won", async () => {
    // The timeout mints and logs its id; the pending promise's later
    // rejection used to mint a SECOND id and log again — two lines, two ids,
    // one user-visible failure (adversarial review 2026-08-14).
    const received = captureReports();

    let rejectLate: (e: Error) => void = () => {};
    const late = new Promise<never>((_, reject) => {
      rejectLate = reject;
    });

    const res = await loadWithTimeout(late, 20);
    expect(res).toMatchObject({ ok: false, reason: "timeout" });
    expect(received).toHaveLength(1);

    rejectLate(new Error("late-boom"));
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1); // still the timeout report only
    expect(received[0].message).toContain("timed out");
  });

  it("does not reject — a rejecting promise never throws out of the helper", async () => {
    await expect(loadWithTimeout(Promise.reject(new Error("x")), 1000)).resolves.toMatchObject({
      ok: false,
    });
  });

  // THE EXCEPTION TO THE RULE ABOVE, and it is not a softening of it.
  //
  // `redirect()` and `notFound()` signal by THROWING a sentinel the framework
  // catches upstream. A helper that swallows every rejection swallows those too,
  // and the failure is silent and aimed at the wrong person: wrap
  // `requireUserOrRedirect()` — which `app/(app)/layout.tsx` now does — and a
  // signed-out visitor gets "no pudimos abrir tu cuenta" instead of the sign-in
  // screen, with nothing logged anywhere to say so.
  //
  // Not hypothetical here: `app/org/[orgToken]/intake/importar/actions.ts:277`
  // carries a note about a NEXT_REDIRECT a loop's catch had already eaten once.
  //
  // The sentinel is matched by its `digest` (`NEXT_REDIRECT;...`), which is how
  // Next itself identifies it, so this fixture is the real shape and not a
  // stand-in that would pass against any implementation.
  it("RE-THROWS Next's redirect instead of folding it into a degraded result", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/iniciar-sesion;307;",
    });
    await expect(loadWithTimeout(Promise.reject(redirectError), 1000)).rejects.toBe(redirectError);
  });

  it("RE-THROWS Next's notFound for the same reason", async () => {
    const notFoundError = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    await expect(loadWithTimeout(Promise.reject(notFoundError), 1000)).rejects.toBe(notFoundError);
  });
});

describe("analyticsRetryHref()", () => {
  it("returns the bare path when there are no params", () => {
    expect(analyticsRetryHref("/admin/programa", {})).toBe("/admin/programa");
  });

  it("keeps the period filter on retry", () => {
    expect(analyticsRetryHref("/admin/censo", { period: "90d" })).toBe("/admin/censo?period=90d");
  });

  it("drops undefined/empty params", () => {
    expect(
      analyticsRetryHref("/admin/poblacion", { period: undefined, from: "", to: "2026-01-01" }),
    ).toBe("/admin/poblacion?to=2026-01-01");
  });
});
