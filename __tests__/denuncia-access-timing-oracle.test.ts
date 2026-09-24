// Pins the property `solicitarAccesoDenunciaAction` claims in its own header:
// nothing observable from outside varies with which branch was taken.
//
// The response STRING was already identical on every branch and stayed that
// way — the leak was the clock. The action awaited the mail send, and that
// await ran on exactly one branch (reference code found AND email matches the
// address on file). Everything else returned without a network hop. Same words,
// different latency: hold a code, submit a few suspected addresses, and the one
// that takes an extra round trip is the reporter's.
//
// So these tests do not assert on wording. They assert that the response does
// not WAIT for the send — which is the only version of the property that an
// attacker with a stopwatch cannot walk around.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fakes — each one lets a single branch of the action be selected by the test
// ---------------------------------------------------------------------------

/** Row the fake db returns; null means "no denuncia with that code". */
let dbRow: { id: string; reporterContactEmail: string | null; closedAt: Date | null } | null = null;

/** Resolvers for the pending send, so a test can observe it started and hung. */
let sendCallCount = 0;
let releaseSend: (() => void) | null = null;

vi.mock("@/db", () => ({
  welfareReports: {
    id: "id",
    referenceCode: "reference_code",
    reporterContactEmail: "reporter_contact_email",
    closedAt: "closed_at",
  },
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (dbRow ? [dbRow] : []),
        }),
      }),
    }),
  },
}));

vi.mock("drizzle-orm", () => ({ eq: () => "eq" }));

vi.mock("@/lib/infra/rate-limit", () => ({
  RateLimitError: class RateLimitError extends Error {},
  callerIp: () => "203.0.113.9",
  enforceRateLimit: async () => undefined,
}));

vi.mock("@/lib/infra/denuncia-reporter-token", () => ({
  generateReporterToken: () => "tok",
  // Only the aged-out branch returns true; tests that need it override dbRow.
  reporterAccessRevoked: (closedAt: Date | null) => closedAt !== null,
}));

vi.mock("@/lib/infra/site-url", () => ({ resolveSiteUrl: () => "https://example.test" }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

// `after` runs its callback WITHOUT awaiting it — the same shape as the real
// implementation, which runs the work once the response is already flushed. A
// mock that awaited here would hide the very regression this file exists for.
const afterCallbacks: Array<() => void> = [];
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void> | void) => {
    afterCallbacks.push(() => void cb());
    void cb();
  },
}));

// The mail send hangs forever until a test releases it. If the action ever goes
// back to awaiting it, the action can never resolve and every test here fails.
vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: () => {
        sendCallCount += 1;
        return new Promise((resolve) => {
          releaseSend = () => resolve({ error: null });
        });
      },
    };
  },
}));

import { solicitarAccesoDenunciaAction } from "@/app/(public)/denuncias/codigo/[code]/actions";

const MATCHING_EMAIL = "denunciante@example.test";
const CODE = "DEN-KB98-RXVH";

function form(code: string, email: string): FormData {
  const fd = new FormData();
  fd.set("code", code);
  fd.set("email", email);
  return fd;
}

async function callAction(code: string, email: string) {
  return await solicitarAccesoDenunciaAction({ message: null }, form(code, email));
}

/**
 * Lets the deferred work run. `sendAccessLink` reaches the mailer through a
 * dynamic `await import("resend")`, so even the scheduled callback does not
 * touch the client synchronously — a count read immediately after the action
 * returns is always 0, whether the send was deferred or never scheduled at all.
 * Flushing first is what makes "did not send" and "sent later" distinguishable.
 */
async function flushDeferred(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  dbRow = null;
  sendCallCount = 0;
  releaseSend = null;
  afterCallbacks.length = 0;
  // Present so `sendAccessLink` reaches the (mocked) Resend client instead of
  // short-circuiting on the missing-key branch — otherwise the hang that makes
  // these tests meaningful never happens.
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
});

afterEach(() => {
  releaseSend?.();
  vi.unstubAllEnvs();
});

describe("solicitarAccesoDenunciaAction — the clock must not leak the branch", () => {
  it("returns on the MATCHING branch while the mail send is still in flight", async () => {
    // This is the whole test file in one assertion. The send is started and
    // never resolves; the action must resolve anyway. Awaiting the send — the
    // original code — makes this hang instead of pass.
    dbRow = { id: "r1", reporterContactEmail: MATCHING_EMAIL, closedAt: null };

    const state = await callAction(CODE, MATCHING_EMAIL);

    expect(state.message).toBeTruthy();
    expect(state.throttled).toBeFalsy();
    // The action has ALREADY returned at this point and the mailer has not
    // even been reached yet — the response never queued behind it.
    expect(sendCallCount).toBe(0);

    // Only now, after the response, does the send start — and then it hangs.
    // Both halves matter: without the first, a build that silently dropped the
    // mail would pass; without the second, an awaited send would.
    await flushDeferred();
    expect(sendCallCount).toBe(1);
    expect(releaseSend).not.toBeNull();
  });

  it("gives the same answer on every branch, and only the matching one sends", async () => {
    // Wording equality was never the broken half — it is asserted here so that
    // a future edit cannot fix the timing while breaking the string.
    const matching = { id: "r1", reporterContactEmail: MATCHING_EMAIL, closedAt: null };

    dbRow = null;
    const unknownCode = await callAction(CODE, MATCHING_EMAIL);
    await flushDeferred();
    const sendsAfterUnknown = sendCallCount;

    dbRow = matching;
    const wrongEmail = await callAction(CODE, "vecino@example.test");
    await flushDeferred();
    const sendsAfterWrongEmail = sendCallCount;

    dbRow = { id: "r1", reporterContactEmail: null, closedAt: null };
    const noEmailOnFile = await callAction(CODE, MATCHING_EMAIL);
    await flushDeferred();
    const sendsAfterNoEmail = sendCallCount;

    dbRow = matching;
    const match = await callAction(CODE, MATCHING_EMAIL);
    await flushDeferred();

    for (const state of [unknownCode, wrongEmail, noEmailOnFile]) {
      expect(state.message).toBe(match.message);
      expect(state.throttled).toBe(match.throttled);
    }
    // No branch except the match may touch the mailer — that asymmetry is
    // fine ONLY because it no longer costs the caller any time.
    expect(sendsAfterUnknown).toBe(0);
    expect(sendsAfterWrongEmail).toBe(0);
    expect(sendsAfterNoEmail).toBe(0);
    expect(sendCallCount).toBe(1);
  });

  it("schedules the send through after(), not a bare floating promise", async () => {
    // A floating `void sendAccessLink(...)` would also make the first test
    // pass, and would ALSO be wrong: on a serverless runtime the invocation can
    // be frozen the moment the response is written, so the mail may never
    // leave. `after()` is the supported way to keep work alive past the
    // response, and this pins that it is the mechanism in use.
    dbRow = { id: "r1", reporterContactEmail: MATCHING_EMAIL, closedAt: null };

    await callAction(CODE, MATCHING_EMAIL);

    expect(afterCallbacks).toHaveLength(1);
  });

  it("does not send for a denuncia whose reporter access window already closed", async () => {
    // Sending here would mint a capability the seguimiento page refuses anyway,
    // and would re-open the timing gap for a closed report.
    dbRow = { id: "r1", reporterContactEmail: MATCHING_EMAIL, closedAt: new Date("2020-01-01") };

    const state = await callAction(CODE, MATCHING_EMAIL);
    await flushDeferred();

    expect(state.message).toBeTruthy();
    expect(sendCallCount).toBe(0);
  });
});
