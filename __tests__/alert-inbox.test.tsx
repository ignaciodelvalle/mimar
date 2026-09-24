// __tests__/alert-inbox.test.tsx — K2 inbox read model + table render.
//
// Covers:
//   - fetchAlertFirings filters (status open/all/specific, metric, province, date)
//   - logAlertInboxView writes a pii_queried row with surface="alert_inbox"
//   - AlertInboxTable renders an accessible table (<caption> + scope="col") with
//     a row for every status, a status badge (icon + text), and a breach badge
//     for old `disparada` firings.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AlertInboxTable } from "@/components/admin/AlertInboxTable";
import type { AlertFiring, AlertFiringStatus } from "@/db";
import { alertFirings, auditLog, db, profiles } from "@/db";
import { fetchAlertFirings, logAlertInboxView } from "@/lib/metrics/alert-firing-inbox";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

// Unique surface marker so audit assertions never collide with real rows.
// (audit_log is append-only — rows cannot be deleted, so the marker is how we
// isolate this test's pii_queried writes.)
const TEST_SURFACE = "alert_inbox_test";

const seededIds: string[] = [];
let actorId = "";

/** Resolve any existing institutional admin id to satisfy the actor FK. */
async function resolveAdminActorId(): Promise<string> {
  const [row] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.role, "admin"))
    .limit(1);
  if (!row) throw new Error("No admin profile seeded — run pnpm seed:panorama");
  return row.id;
}

async function seed(
  overrides: Partial<AlertFiring> & { status: AlertFiringStatus },
): Promise<string> {
  const [row] = await db
    .insert(alertFirings)
    .values({
      metricKey: "active_zoonosis",
      direction: "above",
      threshold: "10",
      observedValue: "42",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
      ...overrides,
    })
    .returning({ id: alertFirings.id });
  seededIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  actorId = await resolveAdminActorId();
  // One firing in each status, all in Buenos Aires.
  await seed({ status: "disparada", firedAt: new Date(Date.now() - 5 * 86400_000) }); // old → breach
  await seed({ status: "reconocida" });
  await seed({
    status: "en_investigacion",
    metricKey: "queue_oldest_days",
    jurisdictionProvince: null,
    jurisdictionLocality: null,
  });
  await seed({ status: "autoridad_contactada", metricKey: "open_welfare_reports" });
  await seed({
    status: "resuelta",
    jurisdictionProvince: "Mendoza",
    jurisdictionLocality: "Mendoza",
  });
  await seed({ status: "descartada" });
});

afterAll(async () => {
  if (seededIds.length > 0) {
    await db.delete(alertFirings).where(inArray(alertFirings.id, seededIds));
  }
  // audit_log is append-only (enforce_audit_log_append_only) — the pii_queried
  // rows from logAlertInboxView cannot be deleted. They are isolated by the
  // unique TEST_SURFACE marker and tolerated as accumulation.
});

describe("fetchAlertFirings — filters", () => {
  it("default status='open' returns only the 4 non-terminal statuses", async () => {
    const rows = await fetchAlertFirings({});
    const mine = rows.filter((r) => seededIds.includes(r.id));
    const statuses = new Set(mine.map((r) => r.status));
    expect(statuses.has("disparada")).toBe(true);
    expect(statuses.has("autoridad_contactada")).toBe(true);
    expect(statuses.has("resuelta")).toBe(false);
    expect(statuses.has("descartada")).toBe(false);
  });

  it("status='all' includes terminal statuses", async () => {
    const rows = await fetchAlertFirings({ status: "all" });
    const mine = rows.filter((r) => seededIds.includes(r.id));
    expect(mine.some((r) => r.status === "resuelta")).toBe(true);
    expect(mine.some((r) => r.status === "descartada")).toBe(true);
  });

  it("status filter narrows to a single status", async () => {
    const rows = await fetchAlertFirings({ status: "reconocida" });
    const mine = rows.filter((r) => seededIds.includes(r.id));
    expect(mine.every((r) => r.status === "reconocida")).toBe(true);
    expect(mine.length).toBe(1);
  });

  it("metric filter narrows to a single metric", async () => {
    const rows = await fetchAlertFirings({ status: "all", metricKey: "open_welfare_reports" });
    const mine = rows.filter((r) => seededIds.includes(r.id));
    expect(mine.every((r) => r.metricKey === "open_welfare_reports")).toBe(true);
  });

  it("province filter narrows to a single province", async () => {
    const rows = await fetchAlertFirings({ status: "all", province: "Mendoza" });
    const mine = rows.filter((r) => seededIds.includes(r.id));
    expect(mine.every((r) => r.jurisdictionProvince === "Mendoza")).toBe(true);
  });

  it("returns rows newest-first", async () => {
    const rows = await fetchAlertFirings({ status: "all" });
    const mine = rows.filter((r) => seededIds.includes(r.id));
    for (let i = 1; i < mine.length; i++) {
      expect(mine[i - 1].firedAt.getTime()).toBeGreaterThanOrEqual(mine[i].firedAt.getTime());
    }
  });
});

describe("logAlertInboxView — PII audit", () => {
  it("writes a pii_queried row with surface and result_count", async () => {
    await logAlertInboxView(actorId, { status: "open", province: "Buenos Aires" }, 7, TEST_SURFACE);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, actorId),
          eq(auditLog.action, "pii_queried"),
          sql`${auditLog.payload}->>'surface' = ${TEST_SURFACE}`,
        ),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect(row).toBeDefined();
    const payload = row.payload as Record<string, unknown>;
    expect(payload.surface).toBe(TEST_SURFACE);
    expect(payload.result_count).toBe(7);
    expect((payload.filters as Record<string, unknown>).province).toBe("Buenos Aires");
  });
});

describe("AlertInboxTable — render + a11y", () => {
  it("renders an accessible table with a caption and scope='col' headers", async () => {
    const rows = await fetchAlertFirings({ status: "all" });
    const mine = rows.filter((r) => seededIds.includes(r.id));
    const html = render(<AlertInboxTable rows={mine} />);
    expect(html).toContain("<caption");
    expect(html).toContain('scope="col"');
    // Column headers present.
    expect(html).toContain("Métrica");
    expect(html).toContain("Antigüedad");
    expect(html).toContain("Estado");
  });

  it("renders a status badge with both icon and text (color not sole cue)", async () => {
    const rows = await fetchAlertFirings({ status: "all" });
    const mine = rows.filter((r) => seededIds.includes(r.id));
    const html = render(<AlertInboxTable rows={mine} />);
    // Text labels for each status.
    expect(html).toContain("Disparada");
    expect(html).toContain("Reconocida");
    expect(html).toContain("En investigación");
    expect(html).toContain("Autoridad contactada");
    expect(html).toContain("Resuelta");
    expect(html).toContain("Descartada");
    // aria-hidden icon glyph accompanies the text.
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows a breach badge for an old disparada firing", async () => {
    const rows = await fetchAlertFirings({ status: "all" });
    const mine = rows.filter((r) => seededIds.includes(r.id));
    const html = render(<AlertInboxTable rows={mine} />);
    // es-AR copy (commit 53e4f7da) — the breach badge reads "Vencido".
    expect(html).toContain("Vencido");
  });

  it("renders the empty state when no rows match", () => {
    const html = render(<AlertInboxTable rows={[]} />);
    expect(html).toContain("Sin alertas que coincidan");
  });
});
