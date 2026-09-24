// __tests__/alert-firings-triage.test.ts — K1 writer + triage action integration.
//
// Live integration against the local Postgres stack. Covers:
//   - WRITER dedup: no second OPEN firing while one is open; reopens when closed.
//   - WRITER per-metric: each of the 6 metrics opens a firing when breaching.
//   - FLEET SWEEP: only live admin owners are evaluated (A10-G3).
//   - TRIAGE actions: acknowledge / open-investigation guard / contact / resolve /
//     dismiss, including invalid-transition rejection.
//
// The evaluator (evaluateAlertSubscriptions) is mocked so "breaching" is
// deterministic without standing up real metric data. Auth (createClient) is
// mocked to a seeded admin. next/cache is mocked.

import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AlertMetricKey } from "@/db";

// ---------------------------------------------------------------------------
// Mocks (declared before importing the SUT)
// ---------------------------------------------------------------------------

const evaluateAlertSubscriptionsMock = vi.fn();
vi.mock("@/lib/metrics/alert-evaluation", () => ({
  evaluateAlertSubscriptions: (...args: unknown[]) => evaluateAlertSubscriptionsMock(...args),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

const getUserMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: getUserMock },
  })),
}));

// openOutbreakInvestigationAction is mocked so the investigation test does not
// depend on the full case-helpers stack; the link wiring is what we assert.
const openInvestigationMock = vi.fn();
vi.mock("@/src/modules/surveillance/actions", () => ({
  openOutbreakInvestigationAction: (...args: unknown[]) => openInvestigationMock(...args),
}));

import {
  acknowledgeFiringAction,
  contactAuthorityFiringAction,
  dismissFiringAction,
  openInvestigationFiringAction,
  registerFollowupFiringAction,
  resolveFiringAction,
} from "@/app/actions/alert-firings";
import { alertFirings, alertSubscriptions, db, notifications, profiles } from "@/db";
import {
  evaluateAndRecordFiringsForAllAdmins,
  recordFiringsForUser,
} from "@/src/modules/alerts/application/firings/record-firings";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const adminSdk = createSupabaseAdmin(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const ADMIN_EMAIL = "alert-triage-admin@dim-test.local";
let adminUserId: string;
const subscriptionIds: string[] = [];

async function ensureAdmin(email: string): Promise<string> {
  const { data: list } = await adminSdk.auth.admin.listUsers({ perPage: 500 });
  const existing = list?.users.find((u) => u.email === email);
  if (existing) {
    const [p] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, existing.id));
    if (p) {
      await db
        .update(profiles)
        .set({ role: "admin", accountType: "institutional", deactivatedAt: null })
        .where(eq(profiles.id, existing.id));
      return existing.id;
    }
    await adminSdk.auth.admin.deleteUser(existing.id);
  }
  const r = await createFreshTestUser(adminSdk, {
    email,
    password: "AlertTriage_2026!",
    email_confirm: true,
  });
  if (r.error || !r.data.user) throw new Error(`createUser: ${r.error?.message}`);
  const id = r.data.user.id;
  await db
    .update(profiles)
    .set({ role: "admin", accountType: "institutional" })
    .where(eq(profiles.id, id));
  return id;
}

async function makeSubscription(
  metricKey: AlertMetricKey,
  province: string | null = "Buenos Aires",
  locality: string | null = "La Plata",
): Promise<string> {
  const [row] = await db
    .insert(alertSubscriptions)
    .values({
      actorUserId: adminUserId,
      metricKey,
      direction: "above",
      threshold: "10",
      jurisdictionProvince: province,
      jurisdictionLocality: locality,
      isActive: true,
    })
    .returning({ id: alertSubscriptions.id });
  subscriptionIds.push(row.id);
  return row.id;
}

/** Build a mocked evaluated subscription row that the writer consumes. */
function evalRow(
  subscriptionId: string,
  metricKey: AlertMetricKey,
  opts: { breaching: boolean; province?: string | null; locality?: string | null } = {
    breaching: true,
  },
) {
  return {
    id: subscriptionId,
    actorUserId: adminUserId,
    metricKey,
    direction: "above" as const,
    threshold: "10",
    jurisdictionProvince: opts.province ?? "Buenos Aires",
    jurisdictionLocality: opts.locality ?? "La Plata",
    label: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    currentValue: opts.breaching ? 42 : 1,
    breaching: opts.breaching,
  };
}

async function clearFiringsFor(subIds: string[]) {
  if (subIds.length === 0) return;
  await db.delete(alertFirings).where(inArray(alertFirings.subscriptionId, subIds));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  adminUserId = await ensureAdmin(ADMIN_EMAIL);
  getUserMock.mockResolvedValue({ data: { user: { id: adminUserId } }, error: null });
});

afterEach(async () => {
  await clearFiringsFor(subscriptionIds);
  evaluateAlertSubscriptionsMock.mockReset();
  openInvestigationMock.mockReset();
  // Re-arm auth after reset of other mocks (getUserMock is independent).
  getUserMock.mockResolvedValue({ data: { user: { id: adminUserId } }, error: null });
});

afterAll(async () => {
  await clearFiringsFor(subscriptionIds);
  if (subscriptionIds.length > 0) {
    await db.delete(alertSubscriptions).where(inArray(alertSubscriptions.id, subscriptionIds));
  }
  await db
    .delete(notifications)
    .where(eq(notifications.notificationType, "alert_authority_contacted"));
});

// ---------------------------------------------------------------------------
// WRITER — dedup
// ---------------------------------------------------------------------------

describe("recordFiringsForUser — dedup", () => {
  it("opens exactly one firing for a breaching subscription", async () => {
    const subId = await makeSubscription("active_zoonosis");
    evaluateAlertSubscriptionsMock.mockResolvedValue([evalRow(subId, "active_zoonosis")]);

    const res = await recordFiringsForUser(adminUserId);
    expect(res.opened).toBe(1);

    const rows = await db.select().from(alertFirings).where(eq(alertFirings.subscriptionId, subId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("disparada");
    expect(Number(rows[0].observedValue)).toBe(42);
  });

  it("does NOT open a second firing while one is still open", async () => {
    const subId = await makeSubscription("active_zoonosis");
    evaluateAlertSubscriptionsMock.mockResolvedValue([evalRow(subId, "active_zoonosis")]);

    await recordFiringsForUser(adminUserId);
    const second = await recordFiringsForUser(adminUserId);

    expect(second.opened).toBe(0);
    const rows = await db.select().from(alertFirings).where(eq(alertFirings.subscriptionId, subId));
    expect(rows).toHaveLength(1);
  });

  it("does not open anything when the subscription is not breaching", async () => {
    const subId = await makeSubscription("active_zoonosis");
    evaluateAlertSubscriptionsMock.mockResolvedValue([
      evalRow(subId, "active_zoonosis", { breaching: false }),
    ]);

    const res = await recordFiringsForUser(adminUserId);
    expect(res.opened).toBe(0);
    const rows = await db.select().from(alertFirings).where(eq(alertFirings.subscriptionId, subId));
    expect(rows).toHaveLength(0);
  });

  it("reopens a firing after the prior one was closed", async () => {
    const subId = await makeSubscription("active_zoonosis");
    evaluateAlertSubscriptionsMock.mockResolvedValue([evalRow(subId, "active_zoonosis")]);

    await recordFiringsForUser(adminUserId);
    // Close the existing firing directly.
    await db
      .update(alertFirings)
      .set({ status: "resuelta" })
      .where(eq(alertFirings.subscriptionId, subId));

    const reopened = await recordFiringsForUser(adminUserId);
    expect(reopened.opened).toBe(1);

    const open = await db
      .select()
      .from(alertFirings)
      .where(and(eq(alertFirings.subscriptionId, subId), eq(alertFirings.status, "disparada")));
    expect(open).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// WRITER — every metric fires when crossing its threshold
// ---------------------------------------------------------------------------

describe("recordFiringsForUser — per-metric firing", () => {
  const METRICS: AlertMetricKey[] = [
    "active_zoonosis",
    "eno_sla_ontime_pct",
    "queue_oldest_days",
    "sterilization_coverage_pct",
    "microchip_penetration_pct",
    "open_welfare_reports",
  ];

  for (const metric of METRICS) {
    it(`opens a firing for ${metric} when breaching`, async () => {
      const subId = await makeSubscription(metric);
      evaluateAlertSubscriptionsMock.mockResolvedValue([evalRow(subId, metric)]);

      const res = await recordFiringsForUser(adminUserId);
      expect(res.opened).toBe(1);

      const [row] = await db
        .select({ metricKey: alertFirings.metricKey })
        .from(alertFirings)
        .where(eq(alertFirings.subscriptionId, subId));
      expect(row.metricKey).toBe(metric);
    });
  }
});

// ---------------------------------------------------------------------------
// FLEET SWEEP — only live admin owners are evaluated (A10-G3)
// ---------------------------------------------------------------------------

describe("evaluateAndRecordFiringsForAllAdmins — live admin owners only", () => {
  const GONE = {
    deactivated: "alert-sweep-deactivated@dim-test.local",
    erased: "alert-sweep-erased@dim-test.local",
    govt: "alert-sweep-govt@dim-test.local",
  } as const;
  const goneIds: Record<keyof typeof GONE, string> = { deactivated: "", erased: "", govt: "" };

  async function subscriptionFor(ownerId: string): Promise<void> {
    const [row] = await db
      .insert(alertSubscriptions)
      .values({
        actorUserId: ownerId,
        metricKey: "active_zoonosis",
        direction: "above",
        threshold: "10",
        isActive: true,
      })
      .returning({ id: alertSubscriptions.id });
    subscriptionIds.push(row.id);
  }

  beforeAll(async () => {
    for (const key of Object.keys(GONE) as (keyof typeof GONE)[]) {
      const r = await createFreshTestUser(adminSdk, {
        email: GONE[key],
        password: "AlertSweep_2026!",
        email_confirm: true,
      });
      if (r.error || !r.data.user) throw new Error(`createUser(${GONE[key]}): ${r.error?.message}`);
      goneIds[key] = r.data.user.id;
    }
    await db
      .update(profiles)
      .set({ role: "admin", accountType: "institutional", deactivatedAt: new Date() })
      .where(eq(profiles.id, goneIds.deactivated));
    await db
      .update(profiles)
      .set({ role: "admin", accountType: "institutional", deletedAt: new Date() })
      .where(eq(profiles.id, goneIds.erased));
    await db
      .update(profiles)
      .set({ role: "govt", accountType: "institutional" })
      .where(eq(profiles.id, goneIds.govt));
    for (const id of [adminUserId, goneIds.deactivated, goneIds.erased, goneIds.govt]) {
      await subscriptionFor(id);
    }
  });

  afterAll(async () => {
    for (const id of Object.values(goneIds)) {
      if (!id) continue;
      await db.delete(alertSubscriptions).where(eq(alertSubscriptions.actorUserId, id));
      await db.delete(profiles).where(eq(profiles.id, id));
      await adminSdk.auth.admin.deleteUser(id);
    }
  });

  it("evaluates the live admin and skips the deactivated, the erased and the non-admin owner", async () => {
    evaluateAlertSubscriptionsMock.mockResolvedValue([]);

    await evaluateAndRecordFiringsForAllAdmins({ maxDurationMs: 60_000 });

    const evaluated = new Set(evaluateAlertSubscriptionsMock.mock.calls.map((c) => c[0]));
    expect(evaluated.has(adminUserId)).toBe(true);
    expect(evaluated.has(goneIds.deactivated)).toBe(false);
    expect(evaluated.has(goneIds.erased)).toBe(false);
    expect(evaluated.has(goneIds.govt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TRIAGE actions
// ---------------------------------------------------------------------------

async function seedFiring(
  metricKey: AlertMetricKey,
  status: "disparada" | "reconocida" = "disparada",
): Promise<string> {
  const subId = await makeSubscription(metricKey);
  const [row] = await db
    .insert(alertFirings)
    .values({
      subscriptionId: subId,
      metricKey,
      direction: "above",
      threshold: "10",
      observedValue: "42",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      status,
    })
    .returning({ id: alertFirings.id });
  return row.id;
}

describe("triage — acknowledge", () => {
  it("disparada → reconocida and stamps acknowledged_at/by", async () => {
    const id = await seedFiring("open_welfare_reports", "disparada");
    const res = await acknowledgeFiringAction(id);
    expect(res).toEqual({ ok: true });

    const [row] = await db.select().from(alertFirings).where(eq(alertFirings.id, id));
    expect(row.status).toBe("reconocida");
    expect(row.acknowledgedAt).toBeInstanceOf(Date);
    expect(row.acknowledgedBy).toBe(adminUserId);
  });

  it("rejects acknowledging an already-acknowledged firing (invalid transition)", async () => {
    const id = await seedFiring("open_welfare_reports", "reconocida");
    const res = await acknowledgeFiringAction(id);
    expect(res).toHaveProperty("error");
  });

  it("rejects a caller with no session", async () => {
    const id = await seedFiring("open_welfare_reports", "disparada");
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: { message: "no session" } });
    const res = await acknowledgeFiringAction(id);
    // requireLiveUser's canonical wording since 2026-08-25. The local guard's
    // copy was the same sentence missing its full stop; the guard is gone and
    // so is the near-duplicate string.
    expect(res).toEqual({ error: "Sesión expirada." });
  });
});

describe("triage — open investigation (zoonosis only, K-D2)", () => {
  it("creates the expediente and links investigation_code for active_zoonosis", async () => {
    const id = await seedFiring("active_zoonosis", "reconocida");
    openInvestigationMock.mockResolvedValue({ ok: true, publicCode: "INV-TEST-001" });

    const res = await openInvestigationFiringAction(id);
    expect(res).toEqual({ ok: true });

    // The disease code passed must be the zoonosis anchor.
    expect(openInvestigationMock).toHaveBeenCalledWith(
      expect.objectContaining({ diseaseCode: "rabies_suspected", linkedSignalEventId: null }),
    );

    const [row] = await db.select().from(alertFirings).where(eq(alertFirings.id, id));
    expect(row.status).toBe("en_investigacion");
    expect(row.investigationCode).toBe("INV-TEST-001");
  });

  it("refuses to open an investigation for a non-zoonosis metric", async () => {
    const id = await seedFiring("queue_oldest_days", "reconocida");
    const res = await openInvestigationFiringAction(id);
    expect(res).toHaveProperty("error");
    expect(openInvestigationMock).not.toHaveBeenCalled();
  });
});

describe("triage — register seguimiento (non-zoonosis note)", () => {
  it("appends a note without opening an expediente", async () => {
    const id = await seedFiring("microchip_penetration_pct", "reconocida");
    const res = await registerFollowupFiringAction(id, "Llamé a la municipalidad.");
    expect(res).toEqual({ ok: true });

    const [row] = await db.select().from(alertFirings).where(eq(alertFirings.id, id));
    // Status unchanged (a note, not a transition).
    expect(row.status).toBe("reconocida");
    expect(row.notes).toContain("Llamé a la municipalidad.");
  });

  it("refuses a seguimiento on a zoonosis metric (use investigation)", async () => {
    const id = await seedFiring("active_zoonosis", "reconocida");
    const res = await registerFollowupFiringAction(id, "nota");
    expect(res).toHaveProperty("error");
  });
});

describe("triage — contact authority", () => {
  it("resolves the jurisdiction govts, notifies them, → autoridad_contactada", async () => {
    // Seed a govt assignment for the firing's jurisdiction.
    const govtId = await ensureAdmin("alert-triage-govt@dim-test.local");
    await db
      .update(profiles)
      .set({ role: "govt", accountType: "institutional" })
      .where(eq(profiles.id, govtId));
    const { govtAssignments } = await import("@/db");
    // Isolate: revoke ALL active assignments for this exact jurisdiction so our
    // seeded govt is the sole authority (findAuthoritiesForJurisdiction returns
    // every active govt covering the tuple; a stale one from another run would
    // make contactedGovtUserId nondeterministic).
    await db
      .update(govtAssignments)
      .set({
        revokedAt: new Date(),
        revokedByUserId: adminUserId,
        revocationReason: "test-isolation",
      })
      .where(
        and(
          eq(govtAssignments.jurisdictionProvince, "Buenos Aires"),
          eq(govtAssignments.jurisdictionLocality, "La Plata"),
        ),
      );
    await db.insert(govtAssignments).values({
      userId: govtId,
      jurisdictionCountry: "AR",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      grantedByUserId: adminUserId,
    });

    const id = await seedFiring("active_zoonosis", "reconocida");
    const res = await contactAuthorityFiringAction(id);
    expect(res).toEqual({ ok: true });

    const [row] = await db.select().from(alertFirings).where(eq(alertFirings.id, id));
    expect(row.status).toBe("autoridad_contactada");
    expect(row.contactedGovtUserId).toBe(govtId);
    expect(row.contactedAt).toBeInstanceOf(Date);

    const notif = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, govtId),
          eq(notifications.notificationType, "alert_authority_contacted"),
        ),
      );
    expect(notif.length).toBeGreaterThanOrEqual(1);

    // Cleanup the seeded govt assignment.
    await db.delete(govtAssignments).where(eq(govtAssignments.userId, govtId));
  });
});

describe("triage — resolve / dismiss", () => {
  it("resolve: reconocida → resuelta with closure notes", async () => {
    const id = await seedFiring("open_welfare_reports", "reconocida");
    const res = await resolveFiringAction(id, "Atendido por el municipio.");
    expect(res).toEqual({ ok: true });

    const [row] = await db.select().from(alertFirings).where(eq(alertFirings.id, id));
    expect(row.status).toBe("resuelta");
    expect(row.resolvedAt).toBeInstanceOf(Date);
    expect(row.resolvedBy).toBe(adminUserId);
    expect(row.notes).toContain("Atendido por el municipio.");
  });

  it("dismiss: disparada → descartada", async () => {
    const id = await seedFiring("queue_oldest_days", "disparada");
    const res = await dismissFiringAction(id, "Falso positivo.");
    expect(res).toEqual({ ok: true });

    const [row] = await db.select().from(alertFirings).where(eq(alertFirings.id, id));
    expect(row.status).toBe("descartada");
  });

  it("rejects dismissing an already-investigated firing", async () => {
    const id = await seedFiring("active_zoonosis", "reconocida");
    await db
      .update(alertFirings)
      .set({ status: "en_investigacion" })
      .where(eq(alertFirings.id, id));
    const res = await dismissFiringAction(id, "x");
    expect(res).toHaveProperty("error");
  });
});
