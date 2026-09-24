// The admin gate on the six alert-firing triage actions (app/actions/
// alert-firings.ts) — B9 and the four liveness checks it never reached.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// `requireAdminUser` was a module-private guard built out of a bare
// `supabase.auth.getUser()` and a hand-rolled `profiles` query. It was thorough
// about the ACCOUNT — role, account type, deactivated, erased — and could not
// see anything the platform decides about the CALLER: not the maintenance
// kill-switch, and not the 8-hour operator shift.
//
// The shift is the one that matters most here, and the reason is arithmetic
// rather than judgement: every caller of these six actions is `role: "admin"`,
// which `isInstitutionalPrincipal` treats as institutional by definition. So
// 100% of this surface's population is exactly the population B9 exists for,
// and the guard they went through was the one guard that could not apply it.
//
// The six actions transition a national surveillance alert: acknowledge, open
// an investigation, register a follow-up, contact the jurisdiction authority,
// resolve, dismiss. "Contactar autoridad" notifies real govt accounts.
//
// Nothing here re-tests the triage use-cases — __tests__/alert-firings-triage.ts
// owns those. This file tests the DOOR.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRequireLiveUser = vi.fn();
vi.mock("@/lib/infra/live-user", () => ({
  requireLiveUser: () => mockRequireLiveUser(),
}));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

const mockAcknowledge = vi.fn();
const mockContactAuthority = vi.fn();
vi.mock("@/src/modules/alerts/application/firings/triage", () => ({
  acknowledgeFiring: (...args: unknown[]) => mockAcknowledge(...args),
  contactAuthorityFiring: (...args: unknown[]) => mockContactAuthority(...args),
  dismissFiring: vi.fn(),
  openInvestigationFiring: vi.fn(),
  registerFollowupFiring: vi.fn(),
  resolveFiring: vi.fn(),
}));

vi.mock("@/src/modules/alerts/application/firings/record-firings", () => ({
  evaluateAndRecordFiringsForAllAdmins: vi.fn(),
}));

import { acknowledgeFiringAction, contactAuthorityFiringAction } from "@/app/actions/alert-firings";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function liveAdmin(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    supabase: {},
    user: { id: "admin-001", email: "admin@mimar.test" },
    profile: {
      id: "admin-001",
      role: "admin",
      accountType: "institutional",
      deactivatedAt: null,
      deletedAt: null,
      ...overrides,
    },
    sessionStartedAt: new Date(),
  };
}

/** A liveness refusal in requireLiveUser's own shape. */
function refusal(reason: string, error: string) {
  return { ok: false, supabase: null, user: null, reason, error };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireLiveUser.mockResolvedValue(liveAdmin());
  mockAcknowledge.mockResolvedValue({ ok: true });
  mockContactAuthority.mockResolvedValue({ ok: true });
});

// ---------------------------------------------------------------------------

describe("alert-firing triage actions — the admin gate", () => {
  it("lets a live institutional admin through and revalidates the console", async () => {
    const result = await acknowledgeFiringAction("firing-001");

    expect(mockAcknowledge).toHaveBeenCalledWith("admin-001", "firing-001");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/admin/alertas");
    expect(result).toEqual({ ok: true });
  });

  // B9. Every caller of these six is role:"admin" — institutional by
  // definition — so the shift applies to the whole population of this surface,
  // and the guard it used to go through could not apply it to any of them.
  it("refuses an admin whose 8-hour shift ran out, and writes nothing", async () => {
    mockRequireLiveUser.mockResolvedValue(
      refusal(
        "SHIFT_EXPIRED",
        "Tu turno de trabajo terminó. Por seguridad cerramos la sesión — volvé a iniciar sesión para seguir.",
      ),
    );

    const result = await acknowledgeFiringAction("firing-001");

    expect(result).toEqual({
      error:
        "Tu turno de trabajo terminó. Por seguridad cerramos la sesión — volvé a iniciar sesión para seguir.",
    });
    expect(mockAcknowledge).not.toHaveBeenCalled();
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  // A layout gates a RENDER. These are Server Action POSTs, whose bodies run
  // before any layout re-renders — which is precisely how a triage transition
  // used to commit during a maintenance window and only then meet the screen.
  it("refuses during a maintenance window", async () => {
    mockRequireLiveUser.mockResolvedValue(
      refusal(
        "MAINTENANCE",
        "miMAR está en mantenimiento. Tu cambio no se registró — probá de nuevo en unos minutos.",
      ),
    );

    const result = await contactAuthorityFiringAction("firing-001");

    expect(result).toEqual({
      error:
        "miMAR está en mantenimiento. Tu cambio no se registró — probá de nuevo en unos minutos.",
    });
    // "Contactar autoridad" notifies real govt accounts. It must not fire from
    // a session the platform has already refused.
    expect(mockContactAuthority).not.toHaveBeenCalled();
  });

  it("refuses an erased account", async () => {
    mockRequireLiveUser.mockResolvedValue(refusal("ACCOUNT_ERASED", "Tu cuenta fue eliminada."));

    const result = await acknowledgeFiringAction("firing-001");

    expect(result).toEqual({ error: "Tu cuenta fue eliminada." });
    expect(mockAcknowledge).not.toHaveBeenCalled();
  });

  it("refuses a deactivated institutional account", async () => {
    mockRequireLiveUser.mockResolvedValue(
      refusal(
        "DEACTIVATED",
        "Tu cuenta institucional está desactivada. Contactá al equipo de miMAR.",
      ),
    );

    const result = await acknowledgeFiringAction("firing-001");

    expect(result).toEqual({
      error: "Tu cuenta institucional está desactivada. Contactá al equipo de miMAR.",
    });
    expect(mockAcknowledge).not.toHaveBeenCalled();
  });

  it("refuses an anonymous caller", async () => {
    mockRequireLiveUser.mockResolvedValue(refusal("NO_SESSION", "Sesión expirada."));

    const result = await acknowledgeFiringAction("firing-001");

    expect(result).toEqual({ error: "Sesión expirada." });
  });

  // The two questions liveness does not answer, and the reason this guard still
  // exists at all rather than being deleted in favour of requireLiveUser.
  it("refuses a govt account — the role check survives the rewrite", async () => {
    mockRequireLiveUser.mockResolvedValue(liveAdmin({ role: "govt" }));

    const result = await acknowledgeFiringAction("firing-001");

    expect(result).toEqual({ error: "Acceso restringido a administradores" });
    expect(mockAcknowledge).not.toHaveBeenCalled();
  });

  it("refuses a PERSONAL account whose role column still reads admin", async () => {
    // The DB-level accountType/role CHECK was dropped in migration 0016, so this
    // shape is one Postgres permits. It is a personal wallet with an operator's
    // role column, and it must not triage a national alert.
    mockRequireLiveUser.mockResolvedValue(liveAdmin({ accountType: "personal" }));

    const result = await acknowledgeFiringAction("firing-001");

    expect(result).toEqual({ error: "Acceso restringido a administradores" });
  });

  it("refuses a caller in the mid-signup window, where no profile row exists yet", async () => {
    mockRequireLiveUser.mockResolvedValue({ ...liveAdmin(), profile: null });

    const result = await acknowledgeFiringAction("firing-001");

    expect(result).toEqual({ error: "Acceso restringido a administradores" });
  });

  it("does not revalidate when the use-case itself refuses", async () => {
    mockAcknowledge.mockResolvedValue({ error: "Esa alerta ya fue reconocida." });

    const result = await acknowledgeFiringAction("firing-001");

    expect(result).toEqual({ error: "Esa alerta ya fue reconocida." });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
