// The two Ley 25.326 rights had NO rate limit at all until WU-R (2026-08-29),
// on either surface. This file is what keeps the two budgets honest — and, more
// importantly, what keeps their two OPPOSITE failure directions from being
// "tidied" into agreement by somebody who reads them a week apart.
//
// WHY THE DIRECTIONS DIFFER, since that is the thing a reader will want to undo:
//   · the EXPORT fails CLOSED. Its payload is the subject's entire PII record,
//     so a limiter outage that let requests through would be an unbounded dump.
//   · the ERASURE fails OPEN. Nothing leaves; refusing on a `rate_limit_buckets`
//     hiccup would deny somebody a legal right over an abuse control.
// Each direction is asserted here, so making them match breaks a test that says
// why they must not.
//
// AND THE ORDER INSIDE THE ERASURE, which is the other thing a reader would
// "fix": the mandatory reason is validated BEFORE the budget is spent. Every
// other limiter on this project runs first, because elsewhere the limiter exists
// to make a malformed hammer cheap. There is no hammer here — the only account
// this call can erase is the caller's own — and the cost of the usual order is
// paid by the one person it should never be paid by: somebody typing a two-word
// reason three times, who then cannot erase their account for a minute.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnforce = vi.fn();
vi.mock("@/lib/infra/rate-limit", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/infra/rate-limit")>("@/lib/infra/rate-limit");
  return {
    ...actual,
    enforceRateLimit: (...args: unknown[]) => mockEnforce(...args),
  };
});

const mockReportError = vi.fn();
vi.mock("@/lib/infra/report-error", () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

// The erasure's own machinery is exercised by erase-subject-data.test.ts. Here
// every step past the guard is stubbed to nothing, so a failure in this file is
// unambiguously about the budget and not about a caretaker sweep.
vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema")>("@/db/schema");
  const empty = { where: () => Promise.resolve([]) };
  const db = {
    select: () => ({ from: () => ({ ...empty, innerJoin: () => empty }) }),
    selectDistinct: () => ({ from: () => ({ innerJoin: () => empty }) }),
    delete: () => empty,
  };
  return { ...schema, db };
});
vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { deleteUser: async () => ({ error: null }) } } }),
}));
vi.mock("@/lib/infra/notification-service", () => ({ createNotification: vi.fn() }));
vi.mock("@/src/modules/pets/application/microchip/replace-microchip", () => ({
  replaceMicrochipForUser: vi.fn(),
}));

import { RateLimitError } from "@/lib/infra/rate-limit";

import {
  SUBJECT_DATA_ERASURE_USER_BUCKET,
  SUBJECT_DATA_ERASURE_USER_LIMIT,
  eraseSubjectDataFor,
} from "../erase-subject-data";
import {
  SUBJECT_DATA_EXPORT_USER_BUCKET,
  SUBJECT_DATA_EXPORT_USER_LIMIT,
  exportSubjectDataFor,
} from "../export-subject-data";

const SUBJECT = "11111111-1111-4111-8111-111111111111";

/** A stand-in for whichever authenticated client the surface handed in. */
function fakeClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as Parameters<typeof exportSubjectDataFor>[0]["supabase"];
}

function throttled() {
  return new RateLimitError(new Date("2026-08-29T12:00:00Z"), "maxPerMinute");
}

beforeEach(() => {
  mockEnforce.mockReset();
  mockReportError.mockReset();
  mockEnforce.mockResolvedValue(undefined);
});

describe("export — derecho de acceso (art. 14)", () => {
  it("spends the shared per-user bucket, keyed on the SUBJECT and not on a surface", async () => {
    // The bucket name and the key are the whole reason the limiter lives in the
    // use-case: a per-transport bucket is one a caller escapes by using the
    // other door (the lesson revoke-sessions.ts recorded on 2026-08-25).
    const rpc = vi.fn().mockResolvedValue({ data: { profile: {} }, error: null });

    const result = await exportSubjectDataFor({ userId: SUBJECT, supabase: fakeClient(rpc) });

    expect(result).toEqual({ ok: true, data: { profile: {} } });
    expect(mockEnforce).toHaveBeenCalledWith(
      SUBJECT_DATA_EXPORT_USER_BUCKET,
      SUBJECT,
      SUBJECT_DATA_EXPORT_USER_LIMIT,
    );
    expect(SUBJECT_DATA_EXPORT_USER_BUCKET).not.toContain("api_v1");
  });

  it("refuses with `rate_limited` and never reaches the RPC when the budget is spent", async () => {
    const rpc = vi.fn();
    mockEnforce.mockRejectedValue(throttled());

    const result = await exportSubjectDataFor({ userId: SUBJECT, supabase: fakeClient(rpc) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("rate_limited");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the limiter itself is broken — no dump on a counter outage", async () => {
    // The mutation this catches: turning the non-RateLimitError arm into the
    // fail-open one the rest of the project uses. That would make a
    // `rate_limit_buckets` outage an unbounded PII export.
    const rpc = vi.fn().mockResolvedValue({ data: { profile: {} }, error: null });
    mockEnforce.mockRejectedValue(new Error("rate_limit_buckets is unreachable"));

    const result = await exportSubjectDataFor({ userId: SUBJECT, supabase: fakeClient(rpc) });

    expect(result.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalled();
  });

  it("reports an empty export as a failure rather than as an empty file", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    const result = await exportSubjectDataFor({ userId: SUBJECT, supabase: fakeClient(rpc) });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("failed");
  });
});

describe("erasure — derecho de supresión (art. 16)", () => {
  it("refuses a short reason WITHOUT spending the budget", async () => {
    // The mutation this catches: moving the length check below
    // `enforceRateLimit`. Somebody typing "no" five times would then burn the
    // per-minute budget on their own typos and be locked out of the one action
    // they cannot come back to later.
    const rpc = vi.fn();

    const result = await eraseSubjectDataFor({
      userId: SUBJECT,
      supabase: fakeClient(rpc),
      reason: "no",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reason_required");
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only reason as a short one", async () => {
    const result = await eraseSubjectDataFor({
      userId: SUBJECT,
      supabase: fakeClient(vi.fn()),
      reason: "        ",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reason_required");
  });

  it("spends the shared per-user bucket once the reason is usable", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });

    await eraseSubjectDataFor({
      userId: SUBJECT,
      supabase: fakeClient(rpc),
      reason: "ya no uso miMAR",
    });

    expect(mockEnforce).toHaveBeenCalledWith(
      SUBJECT_DATA_ERASURE_USER_BUCKET,
      SUBJECT,
      SUBJECT_DATA_ERASURE_USER_LIMIT,
    );
    expect(SUBJECT_DATA_ERASURE_USER_BUCKET).not.toContain("api_v1");
  });

  it("passes the TRIMMED reason to the RPC, so the audit row has no padding", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });

    await eraseSubjectDataFor({
      userId: SUBJECT,
      supabase: fakeClient(rpc),
      reason: "   migro a otra plataforma   ",
    });

    expect(rpc).toHaveBeenCalledWith("erase_subject_data", {
      p_user_id: SUBJECT,
      p_reason: "migro a otra plataforma",
    });
  });

  it("refuses with `rate_limited` and never reaches the RPC when the budget is spent", async () => {
    const rpc = vi.fn();
    mockEnforce.mockRejectedValue(throttled());

    const result = await eraseSubjectDataFor({
      userId: SUBJECT,
      supabase: fakeClient(rpc),
      reason: "ya no uso miMAR",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("rate_limited");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("FAILS OPEN when the limiter itself is broken — a counter outage may not deny a legal right", async () => {
    // The mutation this catches: making this arm match the export's fail-CLOSED
    // one. A `rate_limit_buckets` hiccup would then refuse a supresión, which is
    // an abuse control standing between a person and Ley 25.326 art. 16.
    const rpc = vi.fn().mockResolvedValue({ error: null });
    mockEnforce.mockRejectedValue(new Error("rate_limit_buckets is unreachable"));

    const result = await eraseSubjectDataFor({
      userId: SUBJECT,
      supabase: fakeClient(rpc),
      reason: "ya no uso miMAR",
    });

    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalled();
  });

  it("reports an RPC refusal as `failed`, keeping it distinguishable from a throttle", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: "no autorizado" } });

    const result = await eraseSubjectDataFor({
      userId: SUBJECT,
      supabase: fakeClient(rpc),
      reason: "ya no uso miMAR",
    });

    expect(result).toEqual({ ok: false, reason: "failed", error: "no autorizado" });
  });
});
