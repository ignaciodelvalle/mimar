// _booking-fixture — an APPROVED offering of the seed refugio with ONE future
// slot of capacity 1, made directly in a LOCAL Postgres, for
// e2e/booking-capacity-one.spec.ts.
//
// Capacity 1 is the point: it is the schema default (`slot_capacity`), and it
// is the case where a successful booking FILLS the slot, so the reservar page
// the action re-renders answers notFound(). That 404 used to swallow the
// navigation to the appointment (BookingFormClient's header).
//
// Same rules as _agenda-fixture.ts: LOCAL ONLY through `resolveCleanupTarget`
// (null / no-op elsewhere, and the spec skips on that ENVIRONMENT), and the
// pnpm db:bootstrap seed carries no offering of its own. Cleanup deletes the
// appointments first — appointments.slot_id is ON DELETE RESTRICT — then the
// offering, which cascades to its slots.

import postgres from "postgres";

import { postgresTlsOption } from "../db/tls";
import { resolveCleanupTarget } from "./demo/_db-cleanup";

export const BOOKING_OFFERING_TOKEN = "E2E-SVO-BOOK1-0001";

export type BookingFixture = { offeringToken: string; slotId: string };

async function withLocalSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T | null> {
  const target = resolveCleanupTarget();
  if (target.kind !== "local") return null;
  const sql = postgres(target.url, {
    max: 1,
    onnotice: () => {},
    ssl: postgresTlsOption(target.url),
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function deleteFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    DELETE FROM appointments WHERE service_offering_id IN (
      SELECT id FROM service_offerings WHERE public_token = ${BOOKING_OFFERING_TOKEN})`;
  await sql`DELETE FROM service_offerings WHERE public_token = ${BOOKING_OFFERING_TOKEN}`;
}

/**
 * A fresh offering + one open capacity-1 slot three days out. Null when the run
 * has no local database.
 */
export async function ensureCapacityOneSlot(): Promise<BookingFixture | null> {
  return withLocalSql(async (sql) => {
    const [org] = await sql<Array<{ id: string }>>`
      SELECT id::text AS id FROM organizations WHERE display_name ILIKE 'Refugio Test%'
      ORDER BY created_at LIMIT 1`;
    if (!org) throw new Error("[booking fixture] no seed refugio (scripts/seed-test-users.ts)");

    await deleteFixture(sql);
    const [offering] = await sql<Array<{ id: string }>>`
      INSERT INTO service_offerings (
        public_token, organization_id, jurisdiction_country, jurisdiction_province,
        jurisdiction_locality, service_kind, display_name, description,
        duration_minutes, slot_capacity, status, is_public
      ) VALUES (
        ${BOOKING_OFFERING_TOKEN}, ${org.id}::uuid, 'AR', 'CABA',
        'Palermo', 'sterilization_dog_male', 'E2E — Turno de cupo 1',
        'Fixture de e2e/booking-capacity-one.spec.ts',
        60, 1, 'approved', false
      ) RETURNING id::text AS id`;
    const [slot] = await sql<Array<{ id: string }>>`
      INSERT INTO time_slots (service_offering_id, starts_at, ends_at, capacity)
      VALUES (
        ${offering.id}::uuid,
        date_trunc('hour', now()) + interval '3 days',
        date_trunc('hour', now()) + interval '3 days 1 hour',
        1
      ) RETURNING id::text AS id`;
    return { offeringToken: BOOKING_OFFERING_TOKEN, slotId: slot.id };
  });
}

export async function removeCapacityOneSlot(): Promise<void> {
  await withLocalSql(deleteFixture);
}
