// alcance-geo-first.test.tsx — PO decision 3 ("Operativos GEO-FIRST + PII tras
// confirmación", 2026-07-23).
//
// Integration test for AlcanceScreen (app/gob/outreach/AlcanceScreen.tsx)
// against the local Postgres: the screen must open with LOCALITY AGGREGATES
// (no named pets, no PII audit row) and only reveal one zone's named pet list
// — with the PII audit row firing — after that zone is expanded via
// `?zona=`/`?provincia=`.
//
// Auth guard is mocked (same pattern as outbreak-investigation.test.ts);
// actor profile is inserted directly (no Supabase Auth user needed — mirrors
// outreach-pipelines.test.ts's own logOutreachPiiQuery test).

import { and, eq } from "drizzle-orm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/auth-guards", () => ({
  requireGobReadAccessOrRedirect: vi.fn(),
}));

// OutreachRabiesReminderList (rendered inside an expanded zone) imports the
// "use server" outreach-reminders actions, which import next/cache — mocked
// defensively (same precaution outbreak-investigation.test.ts takes), even
// though this test never triggers the click handlers that would call it.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

// DashboardFreshnessFooter is an ASYNC server component (awaits lastIngestAt)
// — plain react-dom/server (renderToStaticMarkup) cannot render a nested
// async component (it only runs under Next's RSC flight renderer), so it is
// stubbed here exactly like the operativos hub test stubs whole screens for
// the same reason (app/gob/operativos/page.test.tsx). Everything else in
// AlcanceScreen's tree is a plain sync component and renders for real.
vi.mock("@/components/ui/dashboard/DashboardFreshnessFooter", () => ({
  DashboardFreshnessFooter: () => null,
}));

import { AlcanceScreen } from "@/app/gob/outreach/AlcanceScreen";
import { auditLog, db, pets, profiles } from "@/db";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { setAuditMutationGucs, withMutationOverride } from "./_helpers/db-overrides";

const TEST_PROVINCE = "Buenos Aires";
const LOCALITY_A = `alcance-geo-a-${Date.now()}`;
const LOCALITY_B = `alcance-geo-b-${Date.now()}`;

const PET_A1_NAME = `AlcanceOverdueA1-${Date.now()}`;
const PET_A2_NAME = `AlcanceOverdueA2-${Date.now()}`;
const PET_B1_NAME = `AlcanceOverdueB1-${Date.now()}`;

let actorId: string;
// Ids of the pets this suite creates, tracked for scoped cleanup in afterAll.
const createdPetIds: string[] = [];

function govtSession(jurisdictions: { province: string; locality: string }[]) {
  return {
    user: { id: actorId },
    supabase: {} as never,
    profile: { id: actorId, role: "govt" as const },
    jurisdictions,
  };
}

/** Wait one tick+ for the screen's fire-and-forget `void logOutreachPiiQuery(...)`
 *  insert to land before asserting on the audit_log table. */
function flush(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  actorId = crypto.randomUUID();
  await db
    .insert(profiles)
    .values({ id: actorId, displayName: "Alcance Test Operator", role: "govt" });

  // Two overdue (never-vaccinated) pets in LOCALITY_A, one in LOCALITY_B —
  // enough to distinguish per-zone aggregation and per-zone expansion.
  for (const [name, locality] of [
    [PET_A1_NAME, LOCALITY_A],
    [PET_A2_NAME, LOCALITY_A],
    [PET_B1_NAME, LOCALITY_B],
  ] as const) {
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: `PET-ALC-${name}`,
        name,
        species: "dog",
        sex: "male",
        status: "active",
        jurisdictionProvince: TEST_PROVINCE,
        jurisdictionLocality: locality,
      })
      .returning({ id: pets.id });
    createdPetIds.push(pet.id);
  }
});

afterAll(async () => {
  // profiles/audit_log rows for the test actor (audit_log via the GUC bypass,
  // same pattern used elsewhere in this suite).
  await db.transaction(async (tx) => {
    await setAuditMutationGucs(tx);
    await tx.delete(auditLog).where(eq(auditLog.actorUserId, actorId));
  });
  await db.delete(profiles).where(eq(profiles.id, actorId));

  // Each pet is deleted in its OWN transaction, scoped only by its own id —
  // never a broad PET-ALC-* prefix match. pet_events is append-only; these
  // fixtures never wrote any events, but the GUC override (see
  // __tests__/_helpers/db-overrides.ts) is used anyway for consistency and to
  // stay correct if a future change adds events here. Deliberately NOT one
  // transaction over the whole list — a single pet's failure must not block
  // cleanup of the rest (see scheduling-attendance.test.ts's afterAll for the
  // incident this guards against).
  for (const petId of createdPetIds) {
    try {
      await withMutationOverride(async (tx) => {
        await tx.delete(pets).where(eq(pets.id, petId));
      });
    } catch (err) {
      console.error(`alcance-geo-first.test.tsx afterAll: failed to clean up pet ${petId}`, err);
    }
  }
});

describe("AlcanceScreen — geo-first aggregates by default (PO decision 3)", () => {
  it("opens with locality aggregates, not named pets — no PII visible", async () => {
    vi.mocked(requireGobReadAccessOrRedirect).mockResolvedValue(
      govtSession([
        { province: TEST_PROVINCE, locality: LOCALITY_A },
        { province: TEST_PROVINCE, locality: LOCALITY_B },
      ]) as never,
    );

    const node = await AlcanceScreen({ underHub: true, searchParams: {} });
    const html = renderToStaticMarkup(node);

    // Aggregates: both localities show up as ZONE rows with a count.
    expect(html).toContain(LOCALITY_A);
    expect(html).toContain(LOCALITY_B);
    expect(html).toContain("Armar operativo");
    expect(html).toContain("agregado por localidad");

    // No named pet leaks into the aggregate view.
    expect(html).not.toContain(PET_A1_NAME);
    expect(html).not.toContain(PET_A2_NAME);
    expect(html).not.toContain(PET_B1_NAME);
  });

  it("does NOT write a pii_queried audit row for the overdue_rabies pipeline on the aggregates render", async () => {
    vi.mocked(requireGobReadAccessOrRedirect).mockResolvedValue(
      govtSession([
        { province: TEST_PROVINCE, locality: LOCALITY_A },
        { province: TEST_PROVINCE, locality: LOCALITY_B },
      ]) as never,
    );

    await AlcanceScreen({ underHub: true, searchParams: {} });
    await flush();

    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, actorId), eq(auditLog.action, "pii_queried")));
    const overdueRows = rows.filter(
      (r) => (r.payload as Record<string, unknown>).pipeline === "overdue_rabies",
    );
    expect(overdueRows).toHaveLength(0);
  });
});

describe("AlcanceScreen — zone expansion reveals named pets + fires the audit row (PO decision 3)", () => {
  it("?zona=/?provincia= for LOCALITY_A shows ONLY that zone's named pets", async () => {
    vi.mocked(requireGobReadAccessOrRedirect).mockResolvedValue(
      govtSession([
        { province: TEST_PROVINCE, locality: LOCALITY_A },
        { province: TEST_PROVINCE, locality: LOCALITY_B },
      ]) as never,
    );

    const node = await AlcanceScreen({
      underHub: true,
      searchParams: { zona: LOCALITY_A, provincia: TEST_PROVINCE },
    });
    const html = renderToStaticMarkup(node);

    expect(html).toContain(PET_A1_NAME);
    expect(html).toContain(PET_A2_NAME);
    expect(html).not.toContain(PET_B1_NAME);
    expect(html).toContain("Volver a todas las zonas");
  });

  it("writes a pii_queried audit row carrying the expanded zone + its pet count", async () => {
    vi.mocked(requireGobReadAccessOrRedirect).mockResolvedValue(
      govtSession([
        { province: TEST_PROVINCE, locality: LOCALITY_A },
        { province: TEST_PROVINCE, locality: LOCALITY_B },
      ]) as never,
    );

    await AlcanceScreen({
      underHub: true,
      searchParams: { zona: LOCALITY_A, provincia: TEST_PROVINCE },
    });
    await flush();

    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, actorId), eq(auditLog.action, "pii_queried")));
    const overdueRows = rows.filter(
      (r) => (r.payload as Record<string, unknown>).pipeline === "overdue_rabies",
    );
    expect(overdueRows.length).toBeGreaterThanOrEqual(1);
    const payload = overdueRows[0].payload as Record<string, unknown>;
    expect(payload.zone_locality).toBe(LOCALITY_A);
    expect(payload.zone_province).toBe(TEST_PROVINCE);
    expect(payload.result_count).toBe(2);
  });
});
