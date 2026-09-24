// Second factor (TOTP) for institutional accounts — T2-S6.
//
// Three layers (plus the harness TOTP helper, section 4), all without a live GoTrue (the local stack needs a restart before
// its TOTP endpoints answer, see supabase/config.toml [auth.mfa.totp]):
//
//   1. mfa-policy.ts — the pure requirement table.
//   2. mfa-actions.ts — the /mfa and /mfa/configurar steps: who may take them,
//      the per-account code budget, the cookie client doing the verify, and the
//      `mfa_factor_enrolled` audit row.
//   3. reset-mfa-factors.ts — admin-assisted recovery (Supabase has no recovery
//      codes): admin only, never on oneself, credentials reset FIRST (password,
//      sessions, new link), then the hook's lockout counters cleared, then
//      every factor listed AFTER the credential reset removed, audited.
//
// Section 5: the harness factor managers (scripts/lib/seed-mfa.ts,
// _helpers/aal2-session.ts) refuse a Supabase that is not the local machine.
//
// Enrolment hardening (2026-09-18): only a session that authenticated in the
// last 15 minutes may enrol, and a completed enrolment mails the holder.
//
// Where requireLiveUser and the page guards act on the policy is pinned in
// live-user-guard.test.ts and auth-guards.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getProfileCached: vi.fn(),
  enforceRateLimit: vi.fn(),
  writeAuditLog: vi.fn(),
  resolveUserLanding: vi.fn(),
  loadActorProfile: vi.fn(),
  targetRows: [] as Array<{ id: string; accountType: string }>,
  adminListFactors: vi.fn(),
  adminDeleteFactor: vi.fn(),
  resetCredentials: vi.fn(),
  mailEnrolled: vi.fn(),
  bucketDelete: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/infra/request-cache", () => ({ getProfileCached: h.getProfileCached }));
vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return { ...actual, enforceRateLimit: h.enforceRateLimit };
});
vi.mock("@/lib/infra/audit-log", () => ({ writeAuditLog: h.writeAuditLog }));
vi.mock("@/lib/infra/role-landing", () => ({
  resolveUserLanding: h.resolveUserLanding,
  safeReturnTo: (v: string | null | undefined) =>
    v?.startsWith("/") && !v.startsWith("//") ? v : null,
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, like: (column: unknown, pattern: string) => ({ like: [column, pattern] }) };
});
vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => h.targetRows }) }) }),
    delete: (table: unknown) => ({ where: (cond: unknown) => h.bucketDelete(table, cond) }),
  },
  profiles: { id: "id", accountType: "account_type" },
  rateLimitBuckets: { bucketKey: "bucket_key" },
}));
vi.mock("@/src/modules/organizations/application/admin-institutional/helpers", () => ({
  loadActorProfile: h.loadActorProfile,
}));
vi.mock(
  "@/src/modules/organizations/application/admin-institutional/reset-institutional-credentials",
  () => ({ resetInstitutionalCredentialsForAuthority: h.resetCredentials }),
);
vi.mock("@/src/modules/auth/application/mfa/mfa-enrolled-mail", () => ({
  mailMfaFactorEnrolled: h.mailEnrolled,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: { mfa: { listFactors: h.adminListFactors, deleteFactor: h.adminDeleteFactor } },
    },
  }),
}));

import { isInstitutionalPrincipal } from "@/lib/infra/live-user";
import { RateLimitError } from "@/lib/infra/rate-limit";
import { assertLocalSupabaseUrl, ensureSeedTotp } from "@/scripts/lib/seed-mfa";
import { base32Decode, secondsLeftInStep, totp, totpFromKey } from "@/scripts/lib/totp";
import {
  confirmMfaEnrolmentAction,
  startMfaEnrolmentAction,
  verifyMfaChallengeAction,
} from "@/src/modules/auth/application/mfa/mfa-actions";
import {
  MFA_ENROL_MAX_SESSION_AGE_SECONDS,
  isFreshForEnrolment,
  mfaRequirement,
} from "@/src/modules/auth/domain/mfa-policy";
import {
  mfaFailBucketPattern,
  resetMfaFactorsForAuthority,
} from "@/src/modules/organizations/application/admin-institutional/reset-mfa-factors";

import { elevateToAal2 } from "./_helpers/aal2-session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A token whose password authentication happened `ageSeconds` ago (null: no amr at all). */
const token = (aal: string, ageSeconds: number | null = 0) =>
  `${b64({ alg: "HS256" })}.${b64({
    aal,
    ...(ageSeconds === null
      ? {}
      : { amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - ageSeconds }] }),
  })}.sig`;
const VERIFIED = { id: "f-ok", factor_type: "totp", status: "verified" };
const UNVERIFIED = { id: "f-old", factor_type: "totp", status: "unverified" };

const govtProfile = {
  id: "op-1",
  role: "govt",
  accountType: "institutional",
  deactivatedAt: null,
  deletedAt: null,
};

function cookieClient({
  user = { id: "op-1", factors: [] as unknown[] } as {
    id: string;
    email?: string;
    factors?: unknown[];
  } | null,
  aal = "aal1",
  authAgeSeconds = 0 as number | null,
  verifyError = null as unknown,
} = {}) {
  const mfa = {
    challengeAndVerify: vi.fn().mockResolvedValue({ data: {}, error: verifyError }),
    listFactors: vi.fn().mockResolvedValue({ data: { all: user?.factors ?? [] }, error: null }),
    unenroll: vi.fn().mockResolvedValue({ data: {}, error: null }),
    enroll: vi.fn().mockResolvedValue({
      data: {
        id: "f-new",
        type: "totp",
        totp: {
          qr_code: "<svg/>",
          secret: "SECRETBASE32",
          uri: "otpauth://totp/miMAR:op?secret=S",
        },
      },
      error: null,
    }),
  };
  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
      getSession: vi
        .fn()
        .mockResolvedValue({ data: { session: { access_token: token(aal, authAgeSeconds) } } }),
      mfa,
    },
  };
  return { client: client as never, mfa };
}

/** Minimal SQL LIKE matcher with Postgres's default escape character (backslash). */
function likeMatches(pattern: string, value: string): boolean {
  const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "\\") re += escapeRe(pattern[++i] ?? "");
    else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += escapeRe(c);
  }
  return new RegExp(`${re}$`).test(value);
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getProfileCached.mockResolvedValue(govtProfile);
  h.enforceRateLimit.mockResolvedValue(undefined);
  h.writeAuditLog.mockResolvedValue({ id: "audit-1" });
  h.resolveUserLanding.mockResolvedValue("/gob");
  h.loadActorProfile.mockResolvedValue({
    id: "admin-1",
    role: "admin",
    accountType: "institutional",
    deactivatedAt: null,
  });
  h.targetRows = [{ id: "op-1", accountType: "institutional" }];
  h.adminListFactors.mockResolvedValue({ data: { factors: [VERIFIED] }, error: null });
  h.adminDeleteFactor.mockImplementation(async ({ id }: { id: string }) => {
    h.calls.push(`delete:${id}`);
    return { data: { id }, error: null };
  });
  h.calls = [];
  h.resetCredentials.mockImplementation(async () => {
    h.calls.push("credentials");
    return { ok: true, magicLink: "https://example.test/link" };
  });
  h.mailEnrolled.mockResolvedValue(true);
  h.bucketDelete.mockImplementation(async () => {
    h.calls.push("buckets");
  });
});

// ---------------------------------------------------------------------------
// 1. Policy
// ---------------------------------------------------------------------------

describe("mfaRequirement", () => {
  it.each([
    [[], "aal1", "enrol"],
    [[UNVERIFIED], "aal1", "enrol"],
    [[{ ...VERIFIED, factor_type: "phone" }], "aal1", "enrol"],
    [[VERIFIED], "aal1", "challenge"],
    [[VERIFIED], "aal2", "satisfied"],
    [[VERIFIED], null, "unknown"],
    [[], null, "unknown"],
  ] as const)("factors %j at %s → %s", (factors, aal, expected) => {
    expect(mfaRequirement({ factors, aal })).toBe(expected);
  });
});

describe("who is asked for the second factor — same set as caller_meets_institutional_aal (0231)", () => {
  const p = (role: string, accountType: string) =>
    ({ ...govtProfile, role, accountType }) as unknown as Parameters<
      typeof isInstitutionalPrincipal
    >[0];

  it.each([
    ["admin", "personal", true],
    ["govt", "personal", true],
    ["national", "personal", true],
    ["owner", "institutional", true],
    ["owner", "personal", false],
    ["vet", "personal", false],
  ])("role %s on a %s account → %s", (role, accountType, expected) => {
    expect(isInstitutionalPrincipal(p(role, accountType))).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 2. The /mfa steps
// ---------------------------------------------------------------------------

describe("verifyMfaChallengeAction", () => {
  it("verifies the account's OWN verified factor on the cookie client and returns the landing", async () => {
    const { client, mfa } = cookieClient({ user: { id: "op-1", factors: [UNVERIFIED, VERIFIED] } });
    const result = await verifyMfaChallengeAction(
      client,
      { error: null },
      form({ code: "123 456" }),
    );
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: "f-ok", code: "123456" });
    expect(result).toEqual({ error: null, next: "/gob" });
  });

  it("honours a safe returnTo and ignores an unsafe one", async () => {
    const { client } = cookieClient({ user: { id: "op-1", factors: [VERIFIED] } });
    const safe = await verifyMfaChallengeAction(
      client,
      { error: null },
      form({ code: "123456", returnTo: "/gob/cola" }),
    );
    expect(safe.next).toBe("/gob/cola");
    const unsafe = await verifyMfaChallengeAction(
      client,
      { error: null },
      form({ code: "123456", returnTo: "//evil.example" }),
    );
    expect(unsafe.next).toBe("/gob");
  });

  it("refuses a wrong code with one sentence", async () => {
    const { client } = cookieClient({
      user: { id: "op-1", factors: [VERIFIED] },
      verifyError: { message: "Invalid TOTP code entered" },
    });
    const result = await verifyMfaChallengeAction(
      client,
      { error: null },
      form({ code: "000000" }),
    );
    expect(result.error).toMatch(/no es correcto/);
    expect(result.next).toBeUndefined();
  });

  it("rejects a malformed code before spending the budget or calling GoTrue", async () => {
    const { client, mfa } = cookieClient({ user: { id: "op-1", factors: [VERIFIED] } });
    const result = await verifyMfaChallengeAction(
      client,
      { error: null },
      form({ code: "12ab56" }),
    );
    expect(result.error).toMatch(/6 números/);
    expect(h.enforceRateLimit).not.toHaveBeenCalled();
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
  });

  it("spends a per-ACCOUNT budget and refuses when it is spent", async () => {
    const { client, mfa } = cookieClient({ user: { id: "op-1", factors: [VERIFIED] } });
    h.enforceRateLimit.mockRejectedValueOnce(new RateLimitError(new Date(), "auth_mfa_code_user"));
    const result = await verifyMfaChallengeAction(
      client,
      { error: null },
      form({ code: "123456" }),
    );
    expect(h.enforceRateLimit).toHaveBeenCalledWith(
      "auth_mfa_code_user",
      "op-1",
      expect.any(Object),
    );
    expect(result.error).toMatch(/demasiados intentos/i);
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
  });

  it("refuses a personal account and an expired session", async () => {
    h.getProfileCached.mockResolvedValue({
      ...govtProfile,
      role: "owner",
      accountType: "personal",
    });
    const personal = cookieClient({ user: { id: "op-1", factors: [VERIFIED] } });
    expect(
      (await verifyMfaChallengeAction(personal.client, { error: null }, form({ code: "123456" })))
        .error,
    ).toMatch(/institucionales/);
    const gone = cookieClient({ user: null });
    expect(
      (await verifyMfaChallengeAction(gone.client, { error: null }, form({ code: "123456" })))
        .error,
    ).toMatch(/expiró/);
    expect(personal.mfa.challengeAndVerify).not.toHaveBeenCalled();
  });
});

describe("startMfaEnrolmentAction", () => {
  it("clears abandoned unverified factors, enrols TOTP and draws the QR itself", async () => {
    const { client, mfa } = cookieClient({ user: { id: "op-1", factors: [UNVERIFIED] } });
    const result = await startMfaEnrolmentAction(client);
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: "f-old" });
    expect(mfa.enroll).toHaveBeenCalledWith(expect.objectContaining({ factorType: "totp" }));
    if (!("ok" in result)) throw new Error(result.error);
    expect(result.factorId).toBe("f-new");
    expect(result.secret).toBe("SECRETBASE32");
    // Our PNG, never GoTrue's SVG markup.
    expect(result.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("refuses an account that already has a verified factor (a password alone must not swap the phone)", async () => {
    const { client, mfa } = cookieClient({
      user: { id: "op-1", factors: [VERIFIED] },
      aal: "aal2",
    });
    const result = await startMfaEnrolmentAction(client);
    expect("error" in result && result.error).toMatch(/ya tiene un segundo factor/);
    expect(mfa.enroll).not.toHaveBeenCalled();
  });
});

describe("confirmMfaEnrolmentAction", () => {
  it("verifies the new factor and writes mfa_factor_enrolled for the account itself", async () => {
    const { client, mfa } = cookieClient({ user: { id: "op-1", factors: [UNVERIFIED] } });
    const result = await confirmMfaEnrolmentAction(
      client,
      { error: null },
      form({ factorId: "f-new", code: "654321" }),
    );
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: "f-new", code: "654321" });
    expect(h.writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "mfa_factor_enrolled",
        actorUserId: "op-1",
        targetUserId: "op-1",
      }),
    );
    expect(result).toEqual({ error: null, next: "/gob" });
  });

  it("writes NO audit row when the code is wrong", async () => {
    const { client } = cookieClient({
      user: { id: "op-1", factors: [UNVERIFIED] },
      verifyError: { message: "Invalid TOTP code entered" },
    });
    const result = await confirmMfaEnrolmentAction(
      client,
      { error: null },
      form({ factorId: "f-new", code: "654321" }),
    );
    expect(result.error).toMatch(/no es correcto/);
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses to record an 'enrolment' for an account that already has a verified factor", async () => {
    const { client, mfa } = cookieClient({ user: { id: "op-1", factors: [VERIFIED] } });
    await confirmMfaEnrolmentAction(
      client,
      { error: null },
      form({ factorId: "f-ok", code: "654321" }),
    );
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("enrolment needs a fresh session (trust on first use)", () => {
  const now = new Date("2026-09-18T12:00:00Z");
  it.each([
    [0, true],
    [MFA_ENROL_MAX_SESSION_AGE_SECONDS, true],
    [MFA_ENROL_MAX_SESSION_AGE_SECONDS + 1, false],
    [24 * 3600, false],
    [-60, true],
    [-3600, false],
  ])("authenticated %ss ago → fresh %s", (age, expected) => {
    expect(isFreshForEnrolment(new Date(now.getTime() - age * 1000), now)).toBe(expected);
  });

  it("an unknown authentication time is NOT fresh (fails closed)", () => {
    expect(isFreshForEnrolment(null, now)).toBe(false);
  });

  it("start refuses a session that signed in 20 minutes ago, before touching GoTrue", async () => {
    const { client, mfa } = cookieClient({ authAgeSeconds: 20 * 60 });
    const result = await startMfaEnrolmentAction(client);
    expect("error" in result && result.error).toMatch(/hace menos de 15 minutos/);
    expect(mfa.enroll).not.toHaveBeenCalled();
    expect(mfa.unenroll).not.toHaveBeenCalled();
  });

  it("start refuses a token with no amr timestamp at all", async () => {
    const { client, mfa } = cookieClient({ authAgeSeconds: null });
    const result = await startMfaEnrolmentAction(client);
    expect("error" in result && result.error).toMatch(/hace menos de 15 minutos/);
    expect(mfa.enroll).not.toHaveBeenCalled();
  });

  it("confirm refuses a stale session: no verify, no audit, no mail", async () => {
    const { client, mfa } = cookieClient({
      user: { id: "op-1", email: "op@muni.test", factors: [UNVERIFIED] },
      authAgeSeconds: 20 * 60,
    });
    const result = await confirmMfaEnrolmentAction(
      client,
      { error: null },
      form({ factorId: "f-new", code: "654321" }),
    );
    expect(result.error).toMatch(/hace menos de 15 minutos/);
    expect(mfa.challengeAndVerify).not.toHaveBeenCalled();
    expect(h.writeAuditLog).not.toHaveBeenCalled();
    expect(h.mailEnrolled).not.toHaveBeenCalled();
  });

  it("a completed enrolment mails the account holder's own address", async () => {
    const { client } = cookieClient({
      user: { id: "op-1", email: "op@muni.test", factors: [UNVERIFIED] },
    });
    await confirmMfaEnrolmentAction(
      client,
      { error: null },
      form({ factorId: "f-new", code: "654321" }),
    );
    expect(h.mailEnrolled).toHaveBeenCalledTimes(1);
    expect(h.mailEnrolled).toHaveBeenCalledWith({
      to: "op@muni.test",
      enrolledAt: expect.any(Date),
    });
  });

  it("the notice itself carries no link, no secret and no factor id, and degrades without Resend", async () => {
    const actual = await vi.importActual<
      typeof import("@/src/modules/auth/application/mfa/mfa-enrolled-mail")
    >("@/src/modules/auth/application/mfa/mfa-enrolled-mail");
    const html = actual.mfaEnrolledMailHtml(new Date("2026-09-18T15:00:00Z"));
    expect(html).not.toMatch(/href|otpauth|SECRETBASE32|f-new/i);
    expect(html).toMatch(/restablezca tu segundo factor/);
    vi.stubEnv("RESEND_API_KEY", "");
    try {
      expect(
        await actual.mailMfaFactorEnrolled({ to: "op@muni.test", enrolledAt: new Date() }),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a wrong code mails nobody", async () => {
    const { client } = cookieClient({
      user: { id: "op-1", email: "op@muni.test", factors: [UNVERIFIED] },
      verifyError: { message: "Invalid TOTP code entered" },
    });
    await confirmMfaEnrolmentAction(
      client,
      { error: null },
      form({ factorId: "f-new", code: "654321" }),
    );
    expect(h.mailEnrolled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Admin-assisted recovery
// ---------------------------------------------------------------------------

describe("resetMfaFactorsForAuthority", () => {
  const input = { targetUserId: "op-1", reason: "Perdió el teléfono, verificado por llamada" };

  it("removes every factor of the target and audits the removed ids", async () => {
    h.adminListFactors.mockResolvedValue({
      data: { factors: [VERIFIED, UNVERIFIED] },
      error: null,
    });
    const result = await resetMfaFactorsForAuthority("admin-1", input);
    expect(h.adminDeleteFactor).toHaveBeenCalledWith({ userId: "op-1", id: "f-ok" });
    expect(h.adminDeleteFactor).toHaveBeenCalledWith({ userId: "op-1", id: "f-old" });
    expect(h.writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "mfa_factors_reset_by_admin",
        actorUserId: "admin-1",
        targetUserId: "op-1",
        payload: expect.objectContaining({ factor_ids: ["f-ok", "f-old"], complete: true }),
      }),
    );
    expect(result).toEqual({ ok: true, removed: 2, magicLink: "https://example.test/link" });
  });

  it("resets the credentials BEFORE removing any factor (no factor-less account with live sessions)", async () => {
    h.adminListFactors.mockResolvedValue({
      data: { factors: [VERIFIED, UNVERIFIED] },
      error: null,
    });
    await resetMfaFactorsForAuthority("admin-1", input);
    expect(h.resetCredentials).toHaveBeenCalledWith("admin-1", {
      targetUserId: "op-1",
      reason: input.reason,
    });
    expect(h.calls).toEqual(["credentials", "buckets", "delete:f-ok", "delete:f-old"]);
  });

  it("clears the target's mfa_verify_fail buckets once the sessions are revoked (MEDIUM-1)", async () => {
    await resetMfaFactorsForAuthority("admin-1", input);
    expect(h.bucketDelete).toHaveBeenCalledTimes(1);
    expect(h.bucketDelete).toHaveBeenCalledWith(
      { bucketKey: "bucket_key" },
      { like: ["bucket_key", mfaFailBucketPattern("op-1")] },
    );
    expect(h.calls.indexOf("buckets")).toBeGreaterThan(h.calls.indexOf("credentials"));
  });

  it("clears no bucket when the credential reset fails", async () => {
    h.resetCredentials.mockResolvedValue({ error: "No pudimos cerrar las sesiones abiertas" });
    await resetMfaFactorsForAuthority("admin-1", input);
    expect(h.bucketDelete).not.toHaveBeenCalled();
  });

  it("still removes the factors when the buckets cannot be cleared, and says the lockout stays", async () => {
    h.bucketDelete.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await resetMfaFactorsForAuthority("admin-1", input);
    spy.mockRestore();
    expect(h.adminDeleteFactor).toHaveBeenCalledWith({ userId: "op-1", id: "f-ok" });
    expect("error" in result && result.error).toMatch(/bloqueo por códigos incorrectos/);
  });

  it("the bucket pattern covers exactly this account's hour and day buckets", () => {
    const id = "0b7c3e1a-1111-4222-8333-944455556666";
    const pattern = mfaFailBucketPattern(id);
    expect(likeMatches(pattern, `mfa_verify_fail:${id}:hour:1789000000000`)).toBe(true);
    expect(likeMatches(pattern, `mfa_verify_fail:${id}:day:1788998400000`)).toBe(true);
    expect(
      likeMatches(pattern, "mfa_verify_fail:0b7c3e1a-1111-4222-8333-944455556667:hour:1"),
    ).toBe(false);
    expect(likeMatches(pattern, `mfaXverifyXfail:${id}:hour:1`)).toBe(false);
    expect(likeMatches(pattern, `auth_mfa_code_user:${id}`)).toBe(false);
  });

  it("deletes the factors listed AFTER the credential reset, including one enrolled in between (LOW-3)", async () => {
    const LATE = { id: "f-late", factor_type: "totp", status: "verified" };
    h.adminListFactors
      .mockResolvedValueOnce({ data: { factors: [VERIFIED] }, error: null })
      .mockResolvedValueOnce({ data: { factors: [VERIFIED, LATE] }, error: null });
    const result = await resetMfaFactorsForAuthority("admin-1", input);
    expect(h.calls).toEqual(["credentials", "buckets", "delete:f-ok", "delete:f-late"]);
    expect(result).toEqual({ ok: true, removed: 2, magicLink: "https://example.test/link" });
  });

  it("stops before deleting anything when the second read fails (credentials already reset)", async () => {
    h.adminListFactors
      .mockResolvedValueOnce({ data: { factors: [VERIFIED] }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const result = await resetMfaFactorsForAuthority("admin-1", input);
    expect(h.adminDeleteFactor).not.toHaveBeenCalled();
    expect(h.writeAuditLog).not.toHaveBeenCalled();
    expect("error" in result && result.error).toMatch(/no pudimos leer los factores/);
  });

  it("leaves every factor in place when the credential reset fails, and relays its error", async () => {
    h.resetCredentials.mockResolvedValue({ error: "No pudimos cerrar las sesiones abiertas" });
    const result = await resetMfaFactorsForAuthority("admin-1", input);
    expect(result).toEqual({ error: "No pudimos cerrar las sesiones abiertas" });
    expect(h.adminDeleteFactor).not.toHaveBeenCalled();
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses an admin resetting THEIR OWN factor", async () => {
    const result = await resetMfaFactorsForAuthority("op-1", input);
    expect("error" in result && result.error).toMatch(/propio segundo factor/);
    expect(h.adminDeleteFactor).not.toHaveBeenCalled();
  });

  it("refuses a non-admin actor", async () => {
    h.loadActorProfile.mockResolvedValue({ ...govtProfile, id: "g-2" });
    const result = await resetMfaFactorsForAuthority("g-2", input);
    expect(result).toEqual({ error: "CAPABILITY_DENIED" });
    expect(h.adminDeleteFactor).not.toHaveBeenCalled();
  });

  it("refuses a personal target and a short motivo", async () => {
    h.targetRows = [{ id: "op-1", accountType: "personal" }];
    expect(await resetMfaFactorsForAuthority("admin-1", input)).toEqual({
      error: "NOT_INSTITUTIONAL",
    });
    expect(
      "error" in (await resetMfaFactorsForAuthority("admin-1", { ...input, reason: "x" })),
    ).toBe(true);
    expect(h.adminDeleteFactor).not.toHaveBeenCalled();
  });

  it("audits what WAS removed when a deletion fails halfway, and says so", async () => {
    h.adminListFactors.mockResolvedValue({
      data: { factors: [VERIFIED, UNVERIFIED] },
      error: null,
    });
    h.adminDeleteFactor.mockReset();
    h.adminDeleteFactor
      .mockResolvedValueOnce({ data: { id: "f-ok" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const result = await resetMfaFactorsForAuthority("admin-1", input);
    expect("error" in result).toBe(true);
    expect(h.writeAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ factor_ids: ["f-ok"], complete: false }),
      }),
    );
  });

  it("writes no row when there was nothing to remove", async () => {
    h.adminListFactors.mockResolvedValue({ data: { factors: [] }, error: null });
    expect(await resetMfaFactorsForAuthority("admin-1", input)).toEqual({
      ok: true,
      removed: 0,
      magicLink: "https://example.test/link",
    });
    expect(h.writeAuditLog).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. The test-harness TOTP helper (scripts/lib/totp.ts) — RFC 6238 Appendix B
// ---------------------------------------------------------------------------

describe("scripts/lib/totp.ts — RFC 6238 test vectors", () => {
  const SEEDS = {
    sha1: Buffer.from("12345678901234567890"),
    sha256: Buffer.from("12345678901234567890123456789012"),
    sha512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
  } as const;
  const VECTORS: Array<[number, string, string, string]> = [
    [59, "94287082", "46119246", "90693936"],
    [1111111109, "07081804", "68084774", "25091201"],
    [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"],
    [2000000000, "69279037", "90698825", "38618901"],
    [20000000000, "65353130", "77737706", "47863826"],
  ];

  it.each(VECTORS)("T=%i → sha1 %s, sha256 %s, sha512 %s", (time, sha1, sha256, sha512) => {
    expect(totpFromKey(SEEDS.sha1, { time, digits: 8 })).toBe(sha1);
    expect(totpFromKey(SEEDS.sha256, { time, digits: 8, algorithm: "sha256" })).toBe(sha256);
    expect(totpFromKey(SEEDS.sha512, { time, digits: 8, algorithm: "sha512" })).toBe(sha512);
  });

  it("decodes base32 the way authenticator apps do (the RFC seed, 6 digits)", () => {
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString()).toBe(
      "12345678901234567890",
    );
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq====").toString()).toBe(
      "12345678901234567890",
    );
    // Six digits = the last six of the eight-digit vector.
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { time: 59 })).toBe("287082");
    expect(() => base32Decode("A1")).toThrow(/invalid character/);
  });

  it("changes code at the step boundary and not inside it", () => {
    const s = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totp(s, { time: 60 })).toBe(totp(s, { time: 89 }));
    expect(totp(s, { time: 89 })).not.toBe(totp(s, { time: 90 }));
    expect(secondsLeftInStep(30, 61)).toBe(29);
  });
});

// ---------------------------------------------------------------------------
// 5. The harness factor managers refuse a non-local Supabase (review LOW-2)
// ---------------------------------------------------------------------------

describe("harness factor managers are local-only", () => {
  const REMOTE = "https://staging-project.supabase.invalid";

  it("assertLocalSupabaseUrl accepts the local hosts and nothing else", () => {
    for (const url of ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"]) {
      expect(() => assertLocalSupabaseUrl(url, "t")).not.toThrow();
    }
    for (const url of [REMOTE, "http://127.0.0.1.nip.io:54321", "not a url", ""]) {
      expect(() => assertLocalSupabaseUrl(url, "t")).toThrow(/non-local Supabase/);
    }
  });

  it("ensureSeedTotp refuses a remote NEXT_PUBLIC_SUPABASE_URL before any call", async () => {
    await expect(
      ensureSeedTotp(
        { supabaseUrl: REMOTE, anonKey: "anon", serviceRoleKey: "service" },
        "admin@dim.test",
        "x",
      ),
    ).rejects.toThrow(/seed-mfa: refusing to manage MFA factors on a non-local Supabase/);
  });

  it("elevateToAal2 refuses a remote NEXT_PUBLIC_SUPABASE_URL before touching factors", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", REMOTE);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: "u-1" } }, error: null });
    try {
      await expect(elevateToAal2({ auth: { getUser } } as never)).rejects.toThrow(
        /aal2-session: refusing to manage MFA factors on a non-local Supabase/,
      );
      expect(getUser).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
