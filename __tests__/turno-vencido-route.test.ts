// `/turno-vencido` — the route that ENDS a shift-expired operator's session.
//
// WHY THIS FILE EXISTS AT ALL (pre-push review, 2026-08-25)
// ---------------------------------------------------------------------------
// It was the one piece of the 8-hour-shift work that shipped with no test, and
// it was also the piece carrying the defect. The handler discarded the result of
// `supabase.auth.signOut({ scope: "global" })` and redirected unconditionally —
// which rebuilds the redirect loop its own header claims to have designed away.
//
// The mechanism, read out of the vendored auth-js 2.105.4 rather than assumed
// (GoTrueClient `_signOut`): on an admin sign-out error it returns `{ error }`
// and never reaches `_removeSession()`, UNLESS the GoTrue status is 401, 403,
// 404 or the session was already missing. A 500 or a network failure therefore
// leaves the cookies in place. Redirecting anyway sends a still-authenticated
// operator to `/iniciar-sesion`, which forwards an authenticated visitor onward
// by role, which hits the portal's liveness guard, which answers SHIFT_EXPIRED,
// which sends them back here: ERR_TOO_MANY_REDIRECTS, the 2026-07-04 incident
// rebuilt out of the failure mode of its own fix.
//
// So the two cases below are not symmetric decoration. The first pins the happy
// path (it must still redirect, and with `motivo=turno`, because that is what
// the login page reads to explain itself). The second pins the ONLY thing that
// makes the loop impossible: on a sign-out failure NOTHING is redirected.
//
// THE SECOND DEFECT, FOUND IN THE SAME REVIEW: THE ORG VET COULD NOT BE SERVED
// ---------------------------------------------------------------------------
// The handler re-derived the policy with `requireLiveUser` ALONE, and that guard
// applies the shift only behind `isInstitutionalPrincipal` — an `institutional`
// accountType or a `govt`/`admin`/`national` role. A clinic vet holds `role: "vet"` /
// `accountType: "personal"`; their operator-ness lives in
// `organization_memberships`, which requireLiveUser never reads. So the org
// capability path refused them at /org/{token}/atender, the page redirected them
// here, and here they read as `ok: true` → redirect to `/`, cookies untouched,
// no card. The single largest group of B9 operators got neither the sign-out nor
// the explanation, on the shared clinic desk the control was written for.
//
// The last three cases are that end to end: the org vet past the shift IS signed
// out with `motivo=turno`; the same vet inside their shift is bounced home with
// cookies intact; and a CITIZEN with a session older than eight hours is left
// completely alone — which is not a detail but the CSRF argument itself, since
// B9 hands citizens long-lived sessions on purpose and a shift-only predicate
// would have made this URL a working cross-site logout link for most of them.

import { beforeEach, describe, expect, it, vi } from "vitest";

// `redirect()` throws in Next, so everything after it is unreachable. Same
// capture shape as __tests__/auth-guards.test.ts: throw a tagged error and spy
// on the destination.
const mockRedirect = vi.fn((path: string): never => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

const mockRequireLiveUser = vi.fn();
vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: () => mockRequireLiveUser(),
}));

const mockSignOut = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { signOut: mockSignOut } })),
}));

// The membership read is the org-staff leg's antecedent. Mocked at the module
// boundary so the route's decision is exercised without Postgres — but
// `isOperatorShiftExpired` is NOT mocked: the shift arithmetic under test is the
// real one, driven by a real `sessionStartedAt`.
const mockGetActiveMemberships = vi.fn();
vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  getActiveMemberships: (userId: string) => mockGetActiveMemberships(userId),
}));

import { GET } from "@/app/(auth)/turno-vencido/route";

const HOUR_MS = 60 * 60 * 1000;

function shiftExpired() {
  return {
    ok: false as const,
    supabase: null,
    user: { id: "user-uuid-1" },
    reason: "SHIFT_EXPIRED" as const,
    error: "Tu turno de trabajo terminó.",
  };
}

/**
 * A LIVE caller: what `requireLiveUser` returns for an org staffer on a personal
 * profile, and for a citizen. The two are indistinguishable to that guard —
 * which is the whole reason this route needs a second predicate.
 */
function liveSince(hoursAgo: number) {
  return {
    ok: true as const,
    supabase: null,
    user: { id: "user-uuid-1", email: "vet@clinica.test" },
    profile: { role: "vet", accountType: "personal" },
    sessionStartedAt: new Date(Date.now() - hoursAgo * HOUR_MS),
  };
}

/** One active org membership — enough to make the caller an operator under B9. */
const ONE_MEMBERSHIP = [{ membership: { id: "mem-1" }, organization: { id: "org-1" } }];

/** Runs the handler and reports what it did — a redirect, or a real Response. */
async function invoke(): Promise<
  { kind: "redirect"; to: string } | { kind: "response"; response: Response }
> {
  try {
    const response = await GET();
    return { kind: "response", response };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("NEXT_REDIRECT:")) {
      return { kind: "redirect", to: message.slice("NEXT_REDIRECT:".length) };
    }
    throw err;
  }
}

describe("/turno-vencido", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRequireLiveUser.mockReset();
    mockSignOut.mockReset();
    mockGetActiveMemberships.mockReset();
    // Default: no org membership. Every case that needs the org-staff leg says
    // so explicitly, so no test passes because of a shared fixture.
    mockGetActiveMemberships.mockResolvedValue([]);
  });

  it("signs the operator out globally and sends them to login with motivo=turno", async () => {
    mockRequireLiveUser.mockResolvedValue(shiftExpired());
    mockSignOut.mockResolvedValue({ error: null });

    const outcome = await invoke();

    expect(mockSignOut).toHaveBeenCalledWith({ scope: "global" });
    expect(outcome).toEqual({ kind: "redirect", to: "/iniciar-sesion?motivo=turno" });
  });

  it("does NOT redirect when GoTrue refuses the sign-out — that is the loop", async () => {
    mockRequireLiveUser.mockResolvedValue(shiftExpired());
    // The shape auth-js returns for a 5xx: an error, and the cookies still in
    // place because `_removeSession()` was never reached.
    mockSignOut.mockResolvedValue({ error: { status: 500, message: "upstream unavailable" } });

    const outcome = await invoke();

    // THE ASSERTION THAT MATTERS. One redirect here and the operator's browser
    // starts bouncing between this route and the login page until the browser
    // gives up.
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("response");
    if (outcome.kind !== "response") throw new Error("unreachable");
    expect(outcome.response.status).toBe(503);
    expect(outcome.response.headers.get("cache-control")).toBe("no-store");
  });

  it("tells the operator the session is STILL OPEN rather than implying it closed", async () => {
    mockRequireLiveUser.mockResolvedValue(shiftExpired());
    mockSignOut.mockResolvedValue({ error: { status: 500, message: "upstream unavailable" } });

    const outcome = await invoke();
    if (outcome.kind !== "response") throw new Error("expected a terminal response");
    const body = await outcome.response.text();

    // An operator who walks away from a shared municipal desk believing they
    // signed out is a worse outcome than a page admitting it failed. This is the
    // copy half of the fix and it is not decoration.
    expect(body).toContain("tu sesión sigue abierta");
    expect(body).toContain("Volver a intentar");
  });

  it("leaves a session that is not shift-expired completely alone", async () => {
    // The prefetch, the cross-site auto-navigation, the operator who typed the
    // URL. A GET that ends sessions is only safe because of this branch.
    mockRequireLiveUser.mockResolvedValue(liveSince(1));
    mockGetActiveMemberships.mockResolvedValue(ONE_MEMBERSHIP);

    const outcome = await invoke();

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "redirect", to: "/" });
  });

  it("does not launder MAINTENANCE into 'your shift ended'", async () => {
    mockRequireLiveUser.mockResolvedValue({
      ok: false,
      supabase: null,
      user: null,
      reason: "MAINTENANCE",
      error: "En mantenimiento.",
    });

    const outcome = await invoke();

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "redirect", to: "/" });
  });
});

// ---------------------------------------------------------------------------
// The org-staff leg — the principal requireLiveUser structurally cannot refuse
// ---------------------------------------------------------------------------

describe("/turno-vencido — the org staffer on a personal profile", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRequireLiveUser.mockReset();
    mockSignOut.mockReset();
    mockGetActiveMemberships.mockReset();
    mockGetActiveMemberships.mockResolvedValue([]);
  });

  it("signs out a clinic vet whose 8 hours ran out, even though requireLiveUser said ok", async () => {
    // THE DEFECT, END TO END. `requireLiveUser` returns ok for this caller by
    // construction — role "vet", accountType "personal", so its institutional
    // predicate never fires — and the old handler therefore redirected to `/`
    // and touched nothing. The org capability path had already refused them at
    // atender, which is how they got here.
    mockRequireLiveUser.mockResolvedValue(liveSince(9));
    mockGetActiveMemberships.mockResolvedValue(ONE_MEMBERSHIP);
    mockSignOut.mockResolvedValue({ error: null });

    const outcome = await invoke();

    expect(mockGetActiveMemberships).toHaveBeenCalledWith("user-uuid-1");
    // Global, like the institutional branch: eight hours are a property of the
    // PERSON, and a shift that ends on the desktop while the same login stays
    // live on the tablet in the same room is the shared-desk hole with a step.
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "global" });
    expect(outcome).toEqual({ kind: "redirect", to: "/iniciar-sesion?motivo=turno" });
  });

  it("leaves the same vet alone while the shift is still running", async () => {
    mockRequireLiveUser.mockResolvedValue(liveSince(7));
    mockGetActiveMemberships.mockResolvedValue(ONE_MEMBERSHIP);

    const outcome = await invoke();

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "redirect", to: "/" });
  });

  it("does NOT end a citizen's long-lived session, however old it is", async () => {
    // The CSRF argument, as a test. B9 gives citizens weeks-long sessions on
    // purpose, so "older than eight hours" describes an ordinary healthy
    // session. Without the membership leg this URL would be a working
    // cross-site logout link for most of the userbase.
    mockRequireLiveUser.mockResolvedValue(liveSince(24 * 30));
    mockGetActiveMemberships.mockResolvedValue([]);

    const outcome = await invoke();

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "redirect", to: "/" });
  });

  it("leaves a signed-out visitor entirely untouched", async () => {
    // No session, nothing to end, and no membership read worth paying for.
    mockRequireLiveUser.mockResolvedValue({
      ok: false,
      supabase: null,
      user: null,
      reason: "NO_SESSION",
      error: "Sesión expirada.",
    });

    const outcome = await invoke();

    expect(mockGetActiveMemberships).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: "redirect", to: "/" });
  });
});
