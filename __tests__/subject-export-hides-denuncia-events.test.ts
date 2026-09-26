// "Descargar mis datos" does not hand a denunciado the denuncia filed against
// them (privacy audit C1, migration 0262).
//
// export_subject_data is SECURITY DEFINER, so the RLS hide 0115 puts on
// pet_events (an event on a welfare_denuncia case is invisible to the pet's
// owner) never applied inside it: the owner's art. 14 export returned the
// welfare bridge events — the reporter's id, the relato, the exact point.
// The export now applies the same hide. The owner's own events stay.
//
// Every row lives in a transaction that always rolls back (shared DB).

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db } from "@/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

class RollbackSignal extends Error {}

async function inRolledBackTx<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let observed: T | undefined;
  try {
    await db.transaction(async (tx) => {
      observed = await body(tx);
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
  return observed as T;
}

async function seedUser(tx: Tx): Promise<string> {
  const id = randomUUID();
  await tx.execute(
    sql`INSERT INTO auth.users (id, email) VALUES (${id}::uuid, ${`c1-${id}@dim-test.local`})`,
  );
  return id;
}

function token(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 4).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
}

describe("export_subject_data — pet_events of a denuncia case (0262)", () => {
  it("the owner's export keeps their own events and drops the denuncia bridge event", async () => {
    const exported = await inRolledBackTx(async (tx) => {
      const owner = await seedUser(tx);
      const reporter = await seedUser(tx);
      const [pet] = (await tx.execute(sql`
        INSERT INTO public.pets (public_token, name, species, jurisdiction_province, jurisdiction_locality)
        VALUES (${token("DIM-C1")}, 'C1 probe pet', 'dog', 'Buenos Aires', 'La Plata')
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const petId = (pet as { id: string }).id;
      await tx.execute(sql`
        INSERT INTO public.ownerships (pet_id, owner_user_id, role)
        VALUES (${petId}::uuid, ${owner}::uuid, 'owner')
      `);
      const [kase] = (await tx.execute(sql`
        INSERT INTO public.cases (public_code, case_kind, status, primary_subject_kind, primary_pet_id,
                                  jurisdiction_province, jurisdiction_locality, opened_reason)
        VALUES (${token("CAS")}, 'welfare_denuncia', 'open', 'registered_pet', ${petId}::uuid,
                'Buenos Aires', 'La Plata', 'c1 export fixture')
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const caseId = (kase as { id: string }).id;
      const [own] = (await tx.execute(sql`
        INSERT INTO public.pet_events (pet_id, event_type, occurred_at, recorded_by_user_id, author_role, payload)
        VALUES (${petId}::uuid, 'weight_recorded', now(), ${owner}::uuid, 'owner', '{"weight_kg": 12}'::jsonb)
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      const [bridge] = (await tx.execute(sql`
        INSERT INTO public.pet_events (pet_id, event_type, occurred_at, recorded_by_user_id, author_role,
                                       case_id, payload)
        VALUES (${petId}::uuid, 'maltreatment_reported', now(), ${reporter}::uuid, 'owner',
                ${caseId}::uuid, '{"description": "relato del denunciante"}'::jsonb)
        RETURNING id::text AS id
      `)) as unknown as Array<{ id: string }>;
      await tx.execute(
        sql`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner })}, true)`,
      );
      const [out] = (await tx.execute(
        sql`SELECT public.export_subject_data(${owner}::uuid) AS data`,
      )) as unknown as Array<{ data: { pet_events: Array<{ id: string }> } }>;
      return {
        ids: (out?.data.pet_events ?? []).map((e) => e.id),
        own: (own as { id: string }).id,
        bridge: (bridge as { id: string }).id,
      };
    });
    expect(exported.ids).toContain(exported.own);
    expect(exported.ids).not.toContain(exported.bridge);
  });
});
