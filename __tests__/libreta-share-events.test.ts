// The shared libreta link's events (privacy audit W3). The share a vet opens
// never carries a denuncia's bridge event — the reporter's relato — while the
// owner's own observations still show. Rolled back (shared DB).

import { randomUUID } from "node:crypto";

import { TransactionRollbackError, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, petEvents } from "@/db";
import { loadSharedLibretaEvents } from "@/lib/infra/libreta-share-events";

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

describe("loadSharedLibretaEvents", () => {
  it("drops the denuncia bridge symptom_observed and keeps the owner's own", async () => {
    await inRolledBackTx(async (tx) => {
      const [pet] = (await tx.execute(sql`
        INSERT INTO public.pets (public_token, name, species)
        VALUES (${`DIM-W3${randomUUID().slice(0, 2).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`},
                'W3 share probe', 'dog')
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const petId = (pet as { id: string }).id;
      const [kase] = (await tx.execute(sql`
        INSERT INTO public.cases (public_code, case_kind, status, primary_subject_kind, primary_pet_id, opened_reason)
        VALUES (${`CAS-W3${randomUUID().slice(0, 2).toUpperCase()}-SHAR`}, 'welfare_denuncia', 'open',
                'registered_pet', ${petId}::uuid, 'share W3 fixture')
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const [owner] = (await tx.execute(sql`
        select id::text as id from public.profiles where role = 'owner'::user_role limit 1
      `)) as unknown as Array<{ id: string }>;
      const base = {
        petId,
        eventType: "symptom_observed" as const,
        occurredAt: new Date(),
        recordedAt: new Date(),
        recordedByUserId: (owner as { id: string }).id,
        authorRole: "owner" as const,
      };
      const [bridge] = await tx
        .insert(petEvents)
        .values({ ...base, caseId: (kase as { id: string }).id, payload: { notes: "relato" } })
        .returning({ id: petEvents.id });
      const [own] = await tx
        .insert(petEvents)
        .values({ ...base, payload: { notes: "tos" } })
        .returning({ id: petEvents.id });

      const ids = (await loadSharedLibretaEvents(petId, tx)).map((e) => e.id);
      expect(ids).toContain(own?.id);
      expect(ids).not.toContain(bridge?.id);
    });
  });
});
