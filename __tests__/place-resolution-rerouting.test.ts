// Re-routing an OPEN case after a queue resolution (localidades-por-id D9).
//
// An unresolved Mechita case reaches only the provincial unit on the id path.
// Once an admin resolves it to Bragado's row, Bragado's municipal unit holder
// is told — once — and the provincial holder, who already had it, is not
// told again and loses nothing. On the name path nothing changes, and a
// closed case is left alone. Everything happens in a rolled-back transaction.

import { TransactionRollbackError, and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  authorityUnitLocalities,
  db,
  eventNotificationOutbox,
  govtAssignments,
  petEvents,
  pets,
  welfareReports,
} from "@/db";
import { openCase } from "@/lib/infra/case-helpers";
import {
  notifyNewlyCoveringAuthorities,
  retargetPendingOutbox,
} from "@/lib/place/resolution-rerouting";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const MECHITA_BRAGADO = "06112080";

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof TransactionRollbackError)) throw e;
    });
}

async function one<T>(tx: Tx, q: ReturnType<typeof sql>): Promise<T> {
  const rows = (await tx.execute(q)) as unknown as T[];
  expect(rows.length).toBeGreaterThan(0);
  return rows[0] as T;
}

/** Two govt operators with no grants but the one this test gives them. */
async function fixture(tx: Tx) {
  const bragado = (
    await one<{ id: string }>(
      tx,
      sql`select id::text as id from public.ar_localities where indec_id = ${MECHITA_BRAGADO}`,
    )
  ).id;
  const [membership] = await tx
    .select({ unitId: authorityUnitLocalities.unitId })
    .from(authorityUnitLocalities)
    .where(
      and(
        eq(authorityUnitLocalities.localityId, bragado),
        eq(authorityUnitLocalities.level, "municipal"),
      ),
    );
  const municipal = membership?.unitId as string;
  const provincial = (
    await one<{ id: string }>(
      tx,
      sql`select id::text as id from public.authority_units
           where province_code = 'AR-B' and kind = 'provincia'`,
    )
  ).id;
  await tx.execute(sql`
    update public.authority_units set status = 'confirmed', confirmed_at = now()
     where id in (${municipal}::uuid, ${provincial}::uuid)
  `);
  const govts = (await tx.execute(sql`
    select id::text as id from public.profiles
     where role = 'govt' and deactivated_at is null and deleted_at is null and not is_system
     order by created_at limit 2
  `)) as unknown as Array<{ id: string }>;
  expect(govts.length, "two govt profiles must exist (seed)").toBe(2);
  const [local, province] = govts.map((g) => g.id) as [string, string];
  await tx.delete(govtAssignments).where(eq(govtAssignments.userId, local));
  await tx.delete(govtAssignments).where(eq(govtAssignments.userId, province));
  // Every other grant in Buenos Aires would muddy "who is new": park them.
  await tx.execute(sql`
    update public.govt_assignments set revoked_at = now()
     where jurisdiction_province = 'Buenos Aires' and revoked_at is null
  `);
  await tx.insert(govtAssignments).values([
    {
      userId: local,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mechita",
      localityId: bragado,
      authorityUnitId: municipal,
    },
    {
      userId: province,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "",
      authorityUnitId: provincial,
    },
  ]);

  const [report] = await tx
    .insert(welfareReports)
    .values({
      referenceCode: `DEN-RR-${String(Date.now()).slice(-6)}`,
      kind: "neglect",
      severity: "medium",
      description: "rerouting fixture",
      subjectKind: "unowned_animal",
      subjectDescription: "stray test",
      status: "in_progress",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mechita",
    })
    .returning({ id: welfareReports.id });
  const caseRow = await openCase(
    {
      kind: "welfare_denuncia",
      primarySubjectKind: "unowned_animal",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "Mechita",
      openedReason: {
        code: "welfare_report_citizen",
        referenceCode: "DEN-RR",
        kind: "neglect",
        severity: "medium",
      },
      welfareReportId: report?.id as string,
    },
    tx,
  );
  return { bragado, local, province, reportId: report?.id as string, caseId: caseRow.id };
}

describe("notifyNewlyCoveringAuthorities", () => {
  it("the unit that now governs the resolved place is told once; the province holder is not re-told", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixture(tx);
      const input = {
        subjectTable: "welfare_reports" as const,
        subjectId: f.reportId,
        localityId: f.bragado,
      };
      const first = await notifyNewlyCoveringAuthorities(tx, input, { mode: "id" });
      expect(first.notified).toContain(f.local);
      expect(first.notified).not.toContain(f.province);

      const notes = (await tx.execute(sql`
        select user_id::text as "userId" from public.notifications
         where related_case_id = ${f.caseId}::uuid
           and notification_type = 'case_place_resolved_authority'
      `)) as unknown as Array<{ userId: string }>;
      expect(notes.map((n) => n.userId)).toEqual([f.local]);

      // A retry sends nothing new.
      await notifyNewlyCoveringAuthorities(tx, input, { mode: "id" });
      const again = (await tx.execute(sql`
        select count(*)::int as n from public.notifications
         where related_case_id = ${f.caseId}::uuid
           and notification_type = 'case_place_resolved_authority'
      `)) as unknown as Array<{ n: number }>;
      expect(again[0]?.n).toBe(1);
    });
  });

  it("on the name path, or for a closed case, nobody is told", async () => {
    await inRolledBackTx(async (tx) => {
      const f = await fixture(tx);
      const input = { subjectTable: "cases" as const, subjectId: f.caseId, localityId: f.bragado };
      expect((await notifyNewlyCoveringAuthorities(tx, input, { mode: "name" })).notified).toEqual(
        [],
      );
      await tx.execute(sql`
        update public.cases set status = 'closed', closed_at = now(), closed_reason = 'resolved'
         where id = ${f.caseId}::uuid
      `);
      expect((await notifyNewlyCoveringAuthorities(tx, input, { mode: "id" })).notified).toEqual(
        [],
      );
    });
  });
});

// Stage D verify W7: an outbox row snapshotted while the place was unresolved
// takes the resolved row once the queue resolves it — only while it is still
// pending, never a delivered one, and only once.
describe("retargetPendingOutbox", () => {
  it("a pending unresolved row takes the resolved row; a delivered one is untouched; a rerun changes nothing", async () => {
    await inRolledBackTx(async (tx) => {
      const bragado = (
        await one<{ id: string }>(
          tx,
          sql`select id::text as id from public.ar_localities where indec_id = ${MECHITA_BRAGADO}`,
        )
      ).id;
      const [pet] = await tx
        .insert(pets)
        .values({
          publicToken: `RT-${Date.now()}`,
          name: "Reencamino",
          species: "dog",
          sex: "male",
          status: "active",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Mechita",
        })
        .returning({ id: pets.id });
      const petId = pet?.id as string;
      const caseRow = await openCase(
        {
          kind: "bite_incident",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Mechita",
          openedReason: { code: "bite_reported_owner", victimKind: "human", severity: "minor" },
        } as unknown as Parameters<typeof openCase>[0],
        tx,
      );
      const [event] = await tx
        .insert(petEvents)
        .values({
          petId,
          eventType: "note_added",
          occurredAt: new Date(),
          payload: { category: "otro", text: "fixture" },
          authorRole: "system",
          recordedByUserId: null,
          caseId: caseRow.id,
        } as typeof petEvents.$inferInsert)
        .returning({ id: petEvents.id });
      const base = {
        sourceEventId: event?.id as string,
        targetKind: "govt_webhook" as const,
        targetJurisdictionProvince: "Buenos Aires",
        targetJurisdictionLocality: "Mechita",
        targetPlaceMethod: "unresolved",
        payloadSnapshot: {},
        slaDueAt: new Date(Date.now() + 86_400_000),
      };
      const [pending, delivered] = await tx
        .insert(eventNotificationOutbox)
        .values([
          { ...base, status: "pending" as const },
          { ...base, status: "delivered" as const, deliveredAt: new Date() },
        ])
        .returning({ id: eventNotificationOutbox.id });

      const input = { subjectTable: "cases" as const, subjectId: caseRow.id, localityId: bragado };
      expect(await retargetPendingOutbox(tx, input)).toEqual({ retargeted: 1 });
      const rows = await tx
        .select({
          id: eventNotificationOutbox.id,
          localityId: eventNotificationOutbox.targetLocalityId,
          method: eventNotificationOutbox.targetPlaceMethod,
        })
        .from(eventNotificationOutbox)
        .where(
          sql`${eventNotificationOutbox.id} in (${pending?.id}::uuid, ${delivered?.id}::uuid)`,
        );
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect(byId.get(pending?.id as string)).toMatchObject({
        localityId: bragado,
        method: "admin_queue",
      });
      expect(byId.get(delivered?.id as string)).toMatchObject({
        localityId: null,
        method: "unresolved",
      });
      expect(await retargetPendingOutbox(tx, input)).toEqual({ retargeted: 0 });
    });
  });
});
