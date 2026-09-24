// Unit tests for the client observability seam (tasks #56a, #56b).
//
// Locks three things: the payload contract a future provider adapter relies on,
// the redaction guarantee that makes forwarding to a third party acceptable at
// all, and the promise that reporting an error can never itself throw.

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildErrorReport, reportError } from "@/lib/observability/report-error";
import {
  type ErrorSink,
  type RedactedErrorReport,
  resetErrorSink,
  setErrorSink,
} from "@/lib/observability/sink";

/** Installs a capturing sink and returns the array it writes into. */
function captureReports(): RedactedErrorReport[] {
  const received: RedactedErrorReport[] = [];
  const sink: ErrorSink = { name: "test-capture", send: (r) => received.push(r) };
  setErrorSink(sink);
  return received;
}

afterEach(() => {
  resetErrorSink();
  vi.restoreAllMocks();
});

describe("payload contract", () => {
  it("carries message, stack and digest in a structured report", () => {
    const received = captureReports();
    const error = Object.assign(new Error("algo explotó"), { digest: "d-abc123" });

    reportError(error);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ message: "algo explotó", digest: "d-abc123" });
    expect(received[0].stack).toBeDefined();
    expect(received[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("omits digest when the error has none", () => {
    const received = captureReports();

    reportError(new Error("sin digest"), { route: "global-error" });

    expect(received[0].digest).toBeUndefined();
    expect(received[0].context.route).toBe("global-error");
  });

  it("includes the error class name when it is more specific than Error", () => {
    const received = captureReports();

    reportError(new TypeError("x is not a function"));

    expect(received[0].name).toBe("TypeError");
  });

  it("OMITS the class name for a plain Error, which says nothing", () => {
    // The other half of "more specific than Error", and the half nothing
    // pinned: relaxing the guard to `error.name ? …` kept every assertion in
    // this file green, because `toMatchObject` ignores extra properties. A
    // payload contract that only ever asserts presence cannot notice a field
    // that should not be there.
    const received = captureReports();

    reportError(new Error("plain"));

    expect(received[0].name).toBeUndefined();
    expect(received[0]).not.toHaveProperty("name");
  });

  it("puts allowlisted context under `context`, not at the top level", () => {
    const received = captureReports();

    reportError(new Error("boom"), { route: "ErrorBoundary", homeHref: "/gob" });

    expect(received[0].context).toEqual({ route: "ErrorBoundary", homeHref: "/gob" });
    expect(received[0]).not.toHaveProperty("route");
  });

  it("caps the stack so an unbounded blob cannot ride along", () => {
    const error = new Error("deep");
    error.stack = ["Error: deep", ...Array.from({ length: 40 }, (_, i) => `    at f${i} ()`)].join(
      "\n",
    );

    const report = buildErrorReport(error);

    expect(report.stack?.split("\n")).toHaveLength(7);
  });
});

describe("the context allowlist is closed, and enforced at runtime", () => {
  it("DROPS a key that is not on the allowlist", () => {
    const received = captureReports();

    // A JS caller, an `as never`, or a parsed blob can carry keys the type
    // system never saw. The allowlist has to hold without it.
    reportError(new Error("boom"), {
      route: "ErrorBoundary",
      ownerEmail: "ivan@gmail.com",
      dni: "30123456",
      profile: { address: "Av. Bustillo 1234" },
    } as never);

    expect(received[0].context).toEqual({ route: "ErrorBoundary" });
    const serialized = JSON.stringify(received[0]);
    expect(serialized).not.toContain("ivan@gmail.com");
    expect(serialized).not.toContain("30123456");
    expect(serialized).not.toContain("Bustillo");
  });

  it("scrubs the VALUE of an allowlisted key — the org token leak that exists today", () => {
    const received = captureReports();

    // app/org/[orgToken]/error.tsx really does pass `/org/${orgToken}`.
    reportError(new Error("boom"), { route: "ErrorBoundary", homeHref: "/org/9f3kd82hsn2p" });

    expect(received[0].context.homeHref).toBe("/org/[redacted:token]");
  });

  it("keeps an all-digit correlationId, which the scrubber would otherwise eat", () => {
    const received = captureReports();

    // 8 hex chars. 5.1% of them — about one in twenty, not the one in
    // forty-three this comment used to claim — carry a run of 7+ digits and
    // would be eaten by the fail-closed rule. Distinguished by KEY, never by
    // shape.
    reportError(new Error("timeout"), { source: "loadWithTimeout", correlationId: "40318775" });

    expect(received[0].context.correlationId).toBe("40318775");
    expect(received[0].context.source).toBe("loadWithTimeout");
  });

  it("keeps a correlationId whose digits run only to one end", () => {
    // `a0318775` — a 7-digit run with a single non-digit at the front. This is
    // the family the old 2.3% number forgot: it is not all-digits, and the
    // `\d{7,}` rule destroys it anyway. Two of these families exist, and
    // together they are 2.2x the all-digits case on their own.
    const received = captureReports();

    reportError(new Error("timeout"), { correlationId: "a0318775" });

    expect(received[0].context.correlationId).toBe("a0318775");
  });

  it("scrubs an 8-hex-shaped value under a key that is NOT opaque", () => {
    // Which key bypasses the scrubber is decided by KEY, never by the value's
    // shape — a scrubber you can talk your way out of by looking like
    // something safe is not a scrubber. Keying the bypass on
    // /^[0-9a-f]{8}$/ instead left every existing assertion green, because the
    // only value tested against it was a correlationId that matched both ways.
    const received = captureReports();

    reportError(new Error("boom"), { source: "40318775" } as never);

    expect(received[0].context.source).toBe("[redacted:digits]");
  });

  it("bounds the opaque bypass: free text in correlationId is still scrubbed", () => {
    // `correlationId` is declared `string`, and the bypass forwards it
    // verbatim. Everything this app mints there is a short unpunctuated token,
    // so a value that is not one did not come from `newCorrelationId` and the
    // reason for exempting it does not apply. A caller who hung a note on the
    // field — by mistake, or because it looked like a convenient place — would
    // otherwise have shipped it to a third party untouched.
    const received = captureReports();

    reportError(new Error("boom"), {
      correlationId: "owner ivan@gmail.com dni 30123456",
    });

    const value = String(received[0].context.correlationId);
    expect(value).not.toContain("ivan@gmail.com");
    expect(value).not.toContain("30123456");
  });
});

describe("redaction happens before the sink ever sees the report", () => {
  it("scrubs PII out of the message", () => {
    const received = captureReports();

    reportError(new Error("titular 30123456 <ivan@gmail.com> tel +54 9 11 1234-5678"));

    const { message } = received[0];
    expect(message).not.toContain("30123456");
    expect(message).not.toContain("ivan@gmail.com");
    expect(message).not.toContain("1234-5678");
  });

  it("scrubs PII out of the stack", () => {
    const received = captureReports();
    const error = new Error("boom");
    error.stack = "Error: boom\n    at load (/p/DIM-BOBB-0022?access_token=abc123XYZ:1:1)";

    reportError(error);

    expect(received[0].stack).not.toContain("DIM-BOBB-0022");
    expect(received[0].stack).not.toContain("abc123XYZ");
  });

  it("hands a third-party sink nothing that the redactor did not clear", () => {
    // The whole safety argument in one test: whatever a provider adapter
    // receives has already been through redaction.
    const received = captureReports();
    const error = Object.assign(new Error("owner ivan@gmail.com dni 30123456"), {
      digest: "d-1",
    });
    // The share token in the shape this product actually mints, plus a pet
    // credential quoted bare in the message with no path to save it.
    error.stack = "Error\n    at x (/libreta/compartir/LBR-7K2M-9QXD:1:1)";

    reportError(error, { homeHref: "/org/9f3kd82hsn2p" } as never);

    const serialized = JSON.stringify(received[0]);
    expect(serialized).not.toContain("ivan@gmail.com");
    expect(serialized).not.toContain("30123456");
    expect(serialized).not.toContain("LBR-7K2M-9QXD");
    expect(serialized).not.toContain("9f3kd82hsn2p");
  });
});

describe("reporting an error can never make things worse", () => {
  it("does not propagate when the sink throws", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setErrorSink({
      name: "broken-provider",
      send: () => {
        throw new Error("provider SDK exploded");
      },
    });

    // Inside a React error boundary, a throw here turns a recoverable error
    // screen into an unrecoverable one.
    expect(() => reportError(new Error("boom"))).not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("does not forward the original when the error cannot be redacted", () => {
    const received = captureReports();
    const hostile = new Error("placeholder");
    Object.defineProperty(hostile, "message", {
      get() {
        throw new Error("hostile getter");
      },
    });

    expect(() => reportError(hostile)).not.toThrow();
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe("[reportError] failed to build a redacted report");
    expect(received[0].context).toEqual({});
  });
});
