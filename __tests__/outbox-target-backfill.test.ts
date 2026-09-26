// The historic outbox target backfill writes what the planner decides, only
// on rows that never recorded a target, and a rerun changes nothing
// (localidades-por-id). Rolled back.

import { TransactionRollbackError, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, eventNotificationOutbox, petEvents, pets } from "@/db";
import { openCase } from "@/lib/infra/case-helpers";
import { backfillOutboxTargets } from "@/scripts/place-backfill-outbox-targets";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

describe("backfillOutboxTargets", () => {
  it("fills an unrecorded row from the bite case bound for its names; a rerun changes nothing", async () => {
    await inRolledBackTx(async (tx) => {
      const [loc] = (await tx.execute(sql`
        select id::text as id from public.ar_localities where indec_id = '06112080'
      `)) as unknown as Array<{ id: string }>;
      const bragado = loc?.id as string;
      const [pet] = await tx
        .insert(pets)
        .values({
          publicToken: `OB-${Date.now()}`,
          name: "Historia",
          species: "dog",
          sex: "male",
          status: "active",
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Mechita",
        })
        .returning({ id: pets.id });
      const petId = pet?.id as string;
      await openCase(
        {
          kind: "bite_incident",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          jurisdictionProvince: "Buenos Aires",
          jurisdictionLocality: "Mechita",
          localityId: bragado,
          placeMethod: "indec_id",
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
          payload: { category: "otro", text: "historic" },
          authorRole: "system",
          recordedByUserId: null,
        } as typeof petEvents.$inferInsert)
        .returning({ id: petEvents.id });
      const [row] = await tx
        .insert(eventNotificationOutbox)
        .values({
          sourceEventId: event?.id as string,
          targetKind: "govt_webhook",
          targetJurisdictionProvince: "Buenos Aires",
          targetJurisdictionLocality: "Mechita",
          payloadSnapshot: {},
          slaDueAt: new Date(Date.now() + 86_400_000),
          status: "delivered",
          deliveredAt: new Date(),
        })
        .returning({ id: eventNotificationOutbox.id });

      const first = await backfillOutboxTargets(tx);
      expect(first.updated).toBeGreaterThanOrEqual(1);
      const [after] = await tx
        .select({
          localityId: eventNotificationOutbox.targetLocalityId,
          method: eventNotificationOutbox.targetPlaceMethod,
          status: eventNotificationOutbox.status,
        })
        .from(eventNotificationOutbox)
        .where(eq(eventNotificationOutbox.id, row?.id as string));
      // Metadata only: the delivery itself is untouched.
      expect(after).toEqual({ localityId: bragado, method: "indec_id", status: "delivered" });

      const second = await backfillOutboxTargets(tx);
      expect(second.updated).toBe(0);
    });
  });
});
