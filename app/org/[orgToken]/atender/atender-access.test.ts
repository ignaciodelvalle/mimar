// Unit tests for the walk-in clinical-signing authorization boundary
// (app/org/[orgToken]/atender/atender-access.ts) and the code-entry action.
//
// Focus:
//   - The surface requires event.write on the org (no custody needed).
//   - It authorizes through resolveLiveOrgActor, so EVERY liveness refusal —
//     maintenance, no session, erasure, deactivation, and the 8-hour operator
//     shift (B9) — reaches the seven clinical writers behind it. Until
//     2026-08-25 it reached NONE of them: the caller was resolved with a bare
//     `supabase.auth.getUser()` and the capability read was imported straight
//     out of the authz resolver, skipping its first four steps.
//   - The two ORG refusals stay indistinguishable, so the surface is not an
//     org-existence oracle for any signed-in account.
//   - #43 provenance: a validated matrícula signs as verified_professional
//     (authorRole "vet", authorVerified true); everyone else signs as
//     org_registered (authorRole "shelter", authorVerified false).
//   - The code-entry action resolves a DIM code and returns the redirect.
//
// Strategy — pure mock-based, no DB / no Supabase instance (mirrors
// __tests__/pet-access.test.ts).

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { OPERATOR_SHIFT_EXPIRED_MESSAGE } from "@/lib/infra/operator-shift";
import { stripComments } from "@/scripts/lib/strip-comments.mjs";

const mockGetUser = vi.fn();
const mockSupabaseClient = { auth: { getUser: () => mockGetUser() } };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabaseClient),
}));

// Chainable @/db mock. Each terminal `.limit()` shifts one result array off
// dbState.results (FIFO). Since the membership lookup moved into
// resolveLiveOrgActor (mocked below), the queue is now [signerProfile],
// [petRow].
const { chain, dbState } = vi.hoisted(() => {
  const dbState = { results: [] as unknown[][] };
  const chain: Record<string, unknown> = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(dbState.results.shift() ?? []),
  };
  return { chain, dbState };
});

vi.mock("@/db", () => ({
  db: chain,
  pets: {},
  organizations: {},
  organizationMemberships: {},
  profiles: {},
}));

const mockResolveLiveOrgActor = vi.fn();
vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  resolveLiveOrgActor: (...args: unknown[]) => mockResolveLiveOrgActor(...args),
}));

import { lookupAtenderPetAction } from "./actions";
import { resolveAtenderContext, resolveAtenderPet } from "./atender-access";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A LIVE org actor holding `event.write` on the org named by the URL token. */
function liveActor(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    userId: "user-001",
    membership: { id: "mem-001", role: "vet_individual" },
    organization: { id: "org-001", displayName: "Clínica San Roque" },
    granted: new Set(["event.write"]),
    ...overrides,
  };
}

/** A refusal in resolveLiveOrgActor's own shape. */
function refusal(reason: string, error: string | null) {
  return { ok: false, reason, userId: reason === "NO_SESSION" ? null : "user-001", error };
}

function signerProfile(overrides: Record<string, unknown> = {}) {
  return {
    displayName: null,
    matriculaNumber: null,
    matriculaVerified: false,
    ...overrides,
  };
}
function pet(overrides: Record<string, unknown> = {}) {
  return {
    id: "pet-001",
    publicToken: "DIM-ABCD-1234",
    name: "Firulais",
    species: "dog",
    status: "active",
    ...overrides,
  };
}

/** Load the FIFO db result queue. */
function queue(...rows: unknown[][]) {
  dbState.results = rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.results = [];
  mockGetUser.mockResolvedValue({ data: { user: { id: "user-001" } }, error: null });
  mockResolveLiveOrgActor.mockResolvedValue(liveActor());
});

// ---------------------------------------------------------------------------
// resolveAtenderContext — authorization gate
// ---------------------------------------------------------------------------

describe("resolveAtenderContext — authorization", () => {
  it("denies an unauthenticated caller", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(refusal("NO_SESSION", "Sesión expirada."));
    const result = await resolveAtenderContext("ORG-TOKEN");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Sesión expirada.");
      expect(result.reason).toBe("NO_SESSION");
    }
  });

  it("denies a non-member of the org", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(refusal("NO_MEMBERSHIP", null));
    const result = await resolveAtenderContext("ORG-TOKEN");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("No pertenecés a esta organización.");
  });

  // The ORG-EXISTENCE ORACLE, closed by giving both refusals one message. A
  // signed-in account probing /org/{token}/atender must not be able to tell an
  // org it is not a member of from one that does not exist.
  it("says the same thing for an unknown org as for a non-membership", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(refusal("NO_ORGANIZATION", null));
    const unknown = await resolveAtenderContext("NO-SUCH-ORG");
    mockResolveLiveOrgActor.mockResolvedValue(refusal("NO_MEMBERSHIP", null));
    const nonMember = await resolveAtenderContext("ORG-TOKEN");

    expect(unknown.ok).toBe(false);
    expect(nonMember.ok).toBe(false);
    if (!unknown.ok && !nonMember.ok) expect(unknown.error).toBe(nonMember.error);
  });

  it("denies a self-erased account before granting", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(
      refusal("ACCOUNT_ERASED", "Tu cuenta fue eliminada."),
    );
    const result = await resolveAtenderContext("ORG-TOKEN");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Tu cuenta fue eliminada.");
  });

  it("denies a deactivated institutional account", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(
      refusal(
        "DEACTIVATED",
        "Tu cuenta institucional está desactivada. Contactá al equipo de miMAR.",
      ),
    );
    const result = await resolveAtenderContext("ORG-TOKEN");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("DEACTIVATED");
  });

  it("refuses during a maintenance window", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(
      refusal("MAINTENANCE", "miMAR está en mantenimiento."),
    );
    const result = await resolveAtenderContext("ORG-TOKEN");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("MAINTENANCE");
  });

  // B9, THE REASON THIS FILE CHANGED. The walk-in surface is a clinic's shared
  // front desk: the literal scenario the 8-hour shift was written for, and the
  // one surface in the product that reached none of it.
  it("refuses an operator whose 8-hour shift ran out, and says so honestly", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(
      refusal("SHIFT_EXPIRED", OPERATOR_SHIFT_EXPIRED_MESSAGE),
    );
    const result = await resolveAtenderContext("ORG-TOKEN");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The CODE is what the page reads to redirect to /turno-vencido; the copy
      // is what a server action renders in place.
      expect(result.reason).toBe("SHIFT_EXPIRED");
      expect(result.error).toBe(OPERATOR_SHIFT_EXPIRED_MESSAGE);
    }
  });

  it("denies a member without event.write", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(liveActor({ granted: new Set() }));
    const result = await resolveAtenderContext("ORG-TOKEN");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("event.write");
      expect(result.reason).toBe("NO_CAPABILITY");
    }
  });

  it("pins the capability check to the org named by the URL token", async () => {
    queue([signerProfile()]);
    await resolveAtenderContext("ORG-TOKEN");
    expect(mockResolveLiveOrgActor).toHaveBeenCalledWith("ORG-TOKEN");
  });
});

// ---------------------------------------------------------------------------
// The bypass itself — asserted on the SOURCE, not on behaviour
// ---------------------------------------------------------------------------
//
// The behavioural tests above all pass through a MOCK of resolveLiveOrgActor,
// so they prove the mapping and not the wiring: swap the door back for a bare
// getUser() and every one of them still goes green, because the mock would
// simply stop being called. These two read the file.

describe("atender-access.ts — the door it authorizes through", () => {
  // COMMENT-STRIPPED, for the reason every sibling fence learned the hard way:
  // this file's header NAMES the bypass it used to have, in prose, so a raw
  // match would fail on the very documentation that records the fix.
  const src = stripComments(readFileSync("app/org/[orgToken]/atender/atender-access.ts", "utf8"));

  it("never resolves the caller with a bare auth.getUser()", () => {
    expect(src).not.toMatch(/auth\s*\.\s*getUser\s*\(/);
  });

  it("does not read capabilities around the guard", () => {
    // `getGrantedCapabilities` is a READER, not a guard: it answers what a
    // membership may do and never who is asking. Importing it here is exactly
    // how this surface skipped four liveness checks for months.
    expect(src).not.toMatch(/getGrantedCapabilities/);
    expect(src).toMatch(/resolveLiveOrgActor/);
  });
});

// ---------------------------------------------------------------------------
// #43 provenance tier — bound to the SIGNER's validated matrícula
// ---------------------------------------------------------------------------

describe("resolveAtenderPet — #43 provenance", () => {
  it("a non-matriculado signs as org_registered (shelter / unverified)", async () => {
    queue([signerProfile({ matriculaVerified: false })], [pet()]);
    const result = await resolveAtenderPet("ORG-TOKEN", "DIM-ABCD-1234");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventAuthorship).toEqual({
        authorRole: "shelter",
        authorOrganizationId: "org-001",
        authorVerified: false,
      });
      expect(result.signer.matriculaVerified).toBe(false);
      expect(result.signer.label).toBe("Clínica San Roque");
    }
  });

  it("a matriculado signs as verified_professional (vet / verified)", async () => {
    queue([signerProfile({ matriculaVerified: true, matriculaNumber: "MP-4821" })], [pet()]);
    const result = await resolveAtenderPet("ORG-TOKEN", "DIM-ABCD-1234");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventAuthorship).toEqual({
        authorRole: "vet",
        authorOrganizationId: "org-001",
        authorVerified: true,
      });
      expect(result.signer.matriculaVerified).toBe(true);
      expect(result.signer.label).toBe("matrícula MP-4821");
    }
  });

  it("rejects a deceased pet", async () => {
    queue([signerProfile()], [pet({ status: "deceased" })]);
    const result = await resolveAtenderPet("ORG-TOKEN", "DIM-ABCD-1234");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("fallecida");
  });

  it("rejects a malformed DIM code without hitting the pet query", async () => {
    queue([signerProfile()]);
    const result = await resolveAtenderPet("ORG-TOKEN", "NOT-A-TOKEN");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("DIM-XXXX-XXXX");
  });

  it("reports an unknown code", async () => {
    queue([signerProfile()], []); // pet lookup empty
    const result = await resolveAtenderPet("ORG-TOKEN", "DIM-ZZZZ-9999");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No se encontró");
  });

  it("refuses a shift-expired operator BEFORE resolving the pet", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(
      refusal("SHIFT_EXPIRED", OPERATOR_SHIFT_EXPIRED_MESSAGE),
    );
    queue([signerProfile()], [pet()]);
    const result = await resolveAtenderPet("ORG-TOKEN", "DIM-ABCD-1234");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("SHIFT_EXPIRED");
    // Nothing was consumed from the db queue — the refusal came first.
    expect(dbState.results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// lookupAtenderPetAction — code entry resolves + redirects
// ---------------------------------------------------------------------------

describe("lookupAtenderPetAction — code entry", () => {
  it("resolves a valid code and returns the signing-surface redirect", async () => {
    queue([signerProfile()], [pet({ publicToken: "DIM-ABCD-1234" })]);
    const form = new FormData();
    form.set("code", "dim-abcd-1234"); // lower-case — must be normalized
    const result = await lookupAtenderPetAction("ORG-TOKEN", { error: null }, form);
    expect(result.error).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.redirectTo).toBe("/org/ORG-TOKEN/atender/DIM-ABCD-1234");
  });

  it("rejects a malformed code before any lookup", async () => {
    const form = new FormData();
    form.set("code", "hello");
    const result = await lookupAtenderPetAction("ORG-TOKEN", { error: null }, form);
    expect(result.error).toContain("DIM-XXXX-XXXX");
    expect(result.redirectTo).toBeUndefined();
  });

  it("surfaces an authorization failure (no event.write)", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(liveActor({ granted: new Set() }));
    const form = new FormData();
    form.set("code", "DIM-ABCD-1234");
    const result = await lookupAtenderPetAction("ORG-TOKEN", { error: null }, form);
    expect(result.ok).toBeUndefined();
    expect(result.error).toContain("event.write");
  });

  // The clinical writers all share this door, so one test on the entry action
  // stands for all seven: a shift-expired signer is refused with the copy that
  // says what to do, not with a generic "sesión expirada" that would send them
  // to refresh a token that is still perfectly valid.
  it("refuses a shift-expired signer with the honest message", async () => {
    mockResolveLiveOrgActor.mockResolvedValue(
      refusal("SHIFT_EXPIRED", OPERATOR_SHIFT_EXPIRED_MESSAGE),
    );
    const form = new FormData();
    form.set("code", "DIM-ABCD-1234");
    const result = await lookupAtenderPetAction("ORG-TOKEN", { error: null }, form);
    expect(result.error).toBe(OPERATOR_SHIFT_EXPIRED_MESSAGE);
  });
});
