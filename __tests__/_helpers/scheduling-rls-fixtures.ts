// Shared fixtures for the scheduling RLS suites (migrations 0285, 0286, 0288,
// 0290): appointments, service_schedule_rules, time_slots and their
// service_offerings, seen by every caller shape the policies distinguish.
//
// THE WORLD
//   orgA      — owns offering "org"; `member` is active in it, `leftMember`
//               left it.
//   orgB      — owns offering "other"; `otherMember` is active in it.
//   provider  — an independent vet who provides offering "provider".
//   owner     — booked the "org" and "provider" offerings for petA.
//   owner2    — booked the "other" offering for petB.
//   stranger  — a profile with no relation to anything above.
// Each offering carries one schedule rule and one slot; each appointment sits
// on its offering's slot. Every row is written over Drizzle (BYPASSRLS) and
// removed in teardown, children first.

import { inArray, sql } from "drizzle-orm";

import { appointments, db, serviceOfferings, serviceScheduleRules, timeSlots } from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import {
  type VisitFixtures,
  addMembership,
  makeOrg,
  makePet,
  makeProfile,
  newVisitFixtures,
  teardownVisitFixtures,
} from "./visit-fixtures";

export type OfferingKey = "org" | "provider" | "other";
export const OFFERING_KEYS: readonly OfferingKey[] = ["org", "provider", "other"];

export type Probe =
  | "owner"
  | "owner2"
  | "member"
  | "leftMember"
  | "otherMember"
  | "provider"
  | "stranger";

export type SchedulingWorld = {
  fx: VisitFixtures;
  users: Record<Probe, string>;
  orgA: string;
  orgB: string;
  offering: Record<OfferingKey, string>;
  rule: Record<OfferingKey, string>;
  slot: Record<OfferingKey, string>;
  appointment: Record<OfferingKey, string>;
};

/**
 * Build the world, or — if any insert fails — remove whatever was already
 * written before rethrowing, so a broken setup leaves no residue in the
 * shared local database.
 */
export async function buildSchedulingWorld(label: string): Promise<SchedulingWorld> {
  const partial: SchedulingWorld = {
    fx: newVisitFixtures(),
    users: {} as Record<Probe, string>,
    orgA: "",
    orgB: "",
    offering: {} as Record<OfferingKey, string>,
    rule: {} as Record<OfferingKey, string>,
    slot: {} as Record<OfferingKey, string>,
    appointment: {} as Record<OfferingKey, string>,
  };
  try {
    return await populateSchedulingWorld(label, partial);
  } catch (err) {
    await teardownSchedulingWorld(partial);
    throw err;
  }
}

async function populateSchedulingWorld(
  label: string,
  world: SchedulingWorld,
): Promise<SchedulingWorld> {
  const { fx, users, offering, rule, slot, appointment } = world;
  for (const probe of [
    "owner",
    "owner2",
    "member",
    "leftMember",
    "otherMember",
    "provider",
    "stranger",
  ] as const) {
    users[probe] = await makeProfile(fx, `${label}-${probe}`);
  }
  const orgA = await makeOrg(fx, `${label}A`);
  world.orgA = orgA;
  const orgB = await makeOrg(fx, `${label}B`);
  world.orgB = orgB;
  await addMembership(orgA, users.member);
  await addMembership(orgA, users.leftMember, { left: true });
  await addMembership(orgB, users.otherMember);

  const owners: Record<OfferingKey, { organizationId: string } | { providerUserId: string }> = {
    org: { organizationId: orgA },
    provider: { providerUserId: users.provider },
    other: { organizationId: orgB },
  };
  for (const key of OFFERING_KEYS) {
    const [o] = await db
      .insert(serviceOfferings)
      .values({
        publicToken: `OFR-SCHED-${fx.suffix}-${label}-${key}`,
        ...owners[key],
        serviceKind: "vaccination",
        displayName: `Turnos ${label} ${key} ${fx.suffix}`,
        status: "approved",
      })
      .returning({ id: serviceOfferings.id });
    offering[key] = o.id;

    const [r] = await db
      .insert(serviceScheduleRules)
      .values({
        serviceOfferingId: o.id,
        daysOfWeek: [1, 3, 5],
        startTimeLocal: "09:00",
        endTimeLocal: "12:00",
        // A window in the past: the slot materializer (cron-materialize-slots
        // runs it over every active rule, in a concurrent worker) emits
        // nothing for these rules, so it cannot add a slot between this
        // file's teardown deletes. The RLS probes never need materialized slots.
        effectiveFrom: "2026-01-01",
        effectiveUntil: "2026-01-31",
      })
      .returning({ id: serviceScheduleRules.id });
    rule[key] = r.id;

    const startsAt = new Date(Date.UTC(2031, 0, 6, 12, 0, 0));
    const [s] = await db
      .insert(timeSlots)
      .values({
        serviceOfferingId: o.id,
        ruleId: r.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        capacity: 4,
        bookingsCount: 1,
      })
      .returning({ id: timeSlots.id });
    slot[key] = s.id;
  }

  const petA = await makePet(fx, `${label}-A`);
  const petB = await makePet(fx, `${label}-B`);
  const booking: Record<OfferingKey, { petId: string; ownerUserId: string; orgId: string | null }> =
    {
      org: { petId: petA, ownerUserId: users.owner, orgId: orgA },
      provider: { petId: petA, ownerUserId: users.owner, orgId: null },
      other: { petId: petB, ownerUserId: users.owner2, orgId: orgB },
    };
  for (const key of OFFERING_KEYS) {
    const [a] = await db
      .insert(appointments)
      .values({
        publicToken: `APT-SCHED-${fx.suffix}-${label}-${key}`,
        slotId: slot[key],
        petId: booking[key].petId,
        ownerUserId: booking[key].ownerUserId,
        serviceOfferingId: offering[key],
        organizationId: booking[key].orgId,
      })
      .returning({ id: appointments.id });
    appointment[key] = a.id;
  }

  return world;
}

export async function teardownSchedulingWorld(world: SchedulingWorld | undefined): Promise<void> {
  if (!world) return;
  const offerings = Object.values(world.offering).filter(Boolean);
  if (offerings.length > 0) {
    await db.delete(appointments).where(inArray(appointments.serviceOfferingId, offerings));
    await db.delete(timeSlots).where(inArray(timeSlots.serviceOfferingId, offerings));
    await db
      .delete(serviceScheduleRules)
      .where(inArray(serviceScheduleRules.serviceOfferingId, offerings));
    await db.delete(serviceOfferings).where(inArray(serviceOfferings.id, offerings));
  }
  await teardownVisitFixtures(world.fx);
}

export type Role = "anon" | "authenticated";

/** The token's assurance level; omitted means no `aal` claim at all. */
export type Aal = "aal1" | "aal2";

/**
 * Run `statement` as a caller role with spoofed PostgREST claims, inside a
 * transaction that ends with the statement. Returns the rows, or the Postgres
 * error code when it raised. `aal` adds the assurance-level claim GoTrue signs
 * (migration 0231 reads it).
 */
export async function runAs<T = Record<string, unknown>>(
  role: Role,
  userId: string | null,
  statement: ReturnType<typeof sql>,
  aal?: Aal,
): Promise<{ code: string | null; rows: T[] }> {
  try {
    const rows = await db.transaction(async (tx) => {
      const claims = {
        ...(userId ? { sub: userId } : {}),
        role,
        ...(aal ? { aal } : {}),
      };
      await tx.execute(
        sql`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`,
      );
      await tx.execute(
        role === "anon" ? sql`SET LOCAL ROLE anon` : sql`SET LOCAL ROLE authenticated`,
      );
      return (await tx.execute(statement)) as unknown as T[];
    });
    return { code: null, rows };
  } catch (err) {
    return { code: pgErrorCode(err) ?? "unknown", rows: [] };
  }
}

/**
 * The fixture ids of `table` a caller can see, as offering keys, sorted.
 * Throws with the Postgres code if the read raised — a recursion (42P17) or a
 * privilege error is never an empty result.
 */
export async function visibleKeys(
  world: SchedulingWorld,
  table: "appointments" | "service_schedule_rules" | "time_slots" | "service_offerings",
  role: Role,
  userId: string | null,
  aal?: Aal,
): Promise<OfferingKey[]> {
  const ids =
    table === "appointments"
      ? world.appointment
      : table === "time_slots"
        ? world.slot
        : table === "service_offerings"
          ? world.offering
          : world.rule;
  const idList = sql.join(
    OFFERING_KEYS.map((k) => sql`${ids[k]}::uuid`),
    sql`, `,
  );
  const { code, rows } = await runAs<{ id: string }>(
    role,
    userId,
    sql`SELECT id::text AS id FROM ${sql.raw(`public.${table}`)} WHERE id IN (${idList})`,
    aal,
  );
  if (code !== null) throw new Error(`${role} read of ${table} raised ${code}`);
  return OFFERING_KEYS.filter((k) => rows.some((r) => r.id === ids[k]));
}
