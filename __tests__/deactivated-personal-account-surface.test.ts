// A self-deactivated PERSONAL account: writes stop, READS STAY OPEN, and no
// redirect loop is reachable.
//
// THE DEFECT THIS FILE GUARDS
// ---------------------------------------------------------------------------
// `DeactivateAccountDialog` told a person "esta acción es irreversible desde el
// panel. Para reactivar tu cuenta contactá al soporte." Neither half was true.
// `requireLiveUser` read `profiles.deactivated_at` for INSTITUTIONAL accounts
// only, so `selfDeactivatePersonalAccountForUser` wrote a column that no write
// boundary ever consulted: the person was warned about a permanent act that
// cost them precisely nothing.
//
// WHY THE FIX IS NOT ONE LINE, AND WHY THAT IS WHAT THIS FILE TESTS
// ---------------------------------------------------------------------------
// Widening the predicate alone refuses every write from that account — with
// copy telling them to contact support about a decision they made themselves
// and can perfectly well reverse. That is a dead end, and a dead end is worse
// than the lie. So the widening ships with a surface, and the surface's design
// constraint is the thing most likely to be broken later by someone "tidying
// up" the guard:
//
//   DEACTIVATED MUST NOT REDIRECT.
//
// `requireUserOrRedirect` tolerates this one refusal on purpose. Bouncing a
// deactivated account off every surface is literally the 2026-07-04
// ERR_TOO_MANY_REDIRECTS incident (lib/infra/auth-guards.ts, lib/infra/
// role-landing.ts). It is also what would strand a self-deactivated person
// outside the only two things that can help them: the explanation, and the
// button that switches the account back on. /turno-vencido is the precedent for
// "a liveness refusal needs a destination", and it is deliberately NOT the model
// here — that route redirects AND signs the operator out, and both halves are
// exactly wrong for somebody who needs to stay signed in to undo their own act.
//
// So the negative assertions below (redirect NOT called) are the load-bearing
// ones. The positive refusal is easy to keep; the tolerance is easy to lose.
//
// Pure mock-based — no DB, no Supabase instance. The reactivation WRITER's own
// behaviour (anti-race WHERE, audit row, institutional refusal) is DB-backed in
// __tests__/profile-self-service.test.ts, because none of those properties
// survive a mocked drizzle chain.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock: next/navigation — capture the destination rather than letting
// redirect()'s control-flow throw vanish. Mirrors __tests__/auth-guards.test.ts.
// ---------------------------------------------------------------------------

const mockRedirect = vi.fn((path: string): never => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/supabase/server
// ---------------------------------------------------------------------------

const mockGetUser = vi.fn();
const mockGetSession = vi.fn();
const mockSupabaseClient = {
  auth: { getUser: () => mockGetUser(), getSession: () => mockGetSession() },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSupabaseClient),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/infra/request-cache
// ---------------------------------------------------------------------------

const mockGetProfileCached = vi.fn();

vi.mock("@/lib/infra/request-cache", () => ({
  getProfileCached: (...args: unknown[]) => mockGetProfileCached(...args),
}));

import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { DEACTIVATED_MESSAGE_PERSONAL, requireLiveUser } from "@/lib/infra/live-user";
import { isDeactivatedInstitutional } from "@/lib/infra/role-landing";

const USER_ID = "deact-user-001";
const EMAIL = "deact@dim-test.local";

function session() {
  return { data: { user: { id: USER_ID, email: EMAIL } }, error: null };
}

function deactivatedPersonal(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    role: "owner",
    displayName: "Ana",
    accountType: "personal",
    deactivatedAt: new Date("2026-09-01T10:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_MAINTENANCE_MODE", "0");
  mockGetUser.mockResolvedValue(session());
  mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
  mockGetProfileCached.mockResolvedValue(deactivatedPersonal());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Writes stop
// ---------------------------------------------------------------------------

describe("a self-deactivated personal account — writes", () => {
  it("is refused by the write guard, with copy that points at the way back", async () => {
    const result = await requireLiveUser();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("DEACTIVATED");
    expect(result.error).toBe(DEACTIVATED_MESSAGE_PERSONAL);
  });

  // The refusal has to carry an identity, because the page-level wrapper hands
  // this exact refusal back as a complete session. A refusal with `user: null`
  // makes requireUserOrRedirect fail closed to /iniciar-sesion — which is the
  // redirect this whole design exists to avoid.
  it("carries the user on the refusal, which is what lets the read be tolerated", async () => {
    const result = await requireLiveUser();

    if (result.ok) throw new Error("unreachable");
    expect(result.user).toEqual({ id: USER_ID, email: EMAIL });
  });
});

// ---------------------------------------------------------------------------
// Reads stay open — THE NEGATIVE CONTROL
// ---------------------------------------------------------------------------

describe("a self-deactivated personal account — reads", () => {
  it("still gets a session from the page guard, and is NOT redirected anywhere", async () => {
    const session = await requireUserOrRedirect();

    expect(session.user).toEqual({ id: USER_ID, email: EMAIL });
    expect(session.supabase).toBe(mockSupabaseClient);
    // The whole point. Any redirect here — to /iniciar-sesion, to "/", to a
    // dedicated "cuenta desactivada" landing — reintroduces the loop shape and
    // strands the person outside /cuenta, where the reactivation control lives.
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // /cuenta and the citizen shell are the surface, and they are reached by
  // NAVIGATION rather than by a bounce. A guard that redirected would make the
  // surface unreachable no matter how good its copy is.
  it("is not redirected when the guard is called with a returnTo either", async () => {
    await requireUserOrRedirect("/cuenta");

    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // Logging out is a read-path affordance: /cuenta renders the logoutAction
  // form unconditionally, and logoutAction itself is @no-auth-required — it
  // never consults requireLiveUser, precisely so a refused account can still
  // leave. The property that could break it is the guard above bouncing the
  // person off /cuenta before the form renders, which is what this asserts.
  it("can still reach the page that renders its logout form", async () => {
    const session = await requireUserOrRedirect();

    expect(session.user.id).toBe(USER_ID);
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// No redirect loop is reachable
// ---------------------------------------------------------------------------

describe("no redirect loop is reachable for a deactivated personal account", () => {
  // The loop in the 2026-07-04 incident needed TWO redirects chasing each
  // other: a portal guard bouncing the account to "/", and "/" (or /login)
  // sending it straight back by role. `isDeactivatedInstitutional` is the
  // predicate every auto-redirect-by-role call site consults to break that
  // chain — app/page.tsx, the login page, loginAction and the auth callback.
  //
  // It stays INSTITUTIONAL-ONLY on purpose even though requireLiveUser no
  // longer is, and the asymmetry is the loop-safety argument: a deactivated
  // personal account is redirected into the citizen portal by role exactly as
  // before, and the citizen portal does not bounce it back out. Widening this
  // predicate to match the guard would send it to /iniciar-sesion instead,
  // where an authenticated visitor is redirected onward by role — rebuilding
  // the loop from the other side.
  it("is NOT caught by isDeactivatedInstitutional, so role landing still resolves", () => {
    expect(isDeactivatedInstitutional(deactivatedPersonal())).toBe(false);
    // Non-vacuity: the predicate still catches the population it is for.
    expect(isDeactivatedInstitutional(deactivatedPersonal({ accountType: "institutional" }))).toBe(
      true,
    );
  });

  // Erasure outranks deactivation, and must keep doing so: an erased account is
  // redirected to /iniciar-sesion and has no reactivation path at all. If this
  // ever flipped, an erased person would be handed the citizen shell plus a
  // button offering to switch their erased account back on.
  it("an ERASED account is still refused as erased, not as deactivated", async () => {
    mockGetProfileCached.mockResolvedValue(
      deactivatedPersonal({ deletedAt: new Date("2026-09-02") }),
    );

    const result = await requireLiveUser();

    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("ACCOUNT_ERASED");
  });
});
