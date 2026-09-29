// Fixtures for the visits tests (migration 0273, vet-visit-record).
//
// Every row is keyed by a per-run random suffix and fresh UUIDs, so two runs —
// or a run and a crashed run's residue — never collide, and teardown deletes
// exactly what this run wrote. Profiles are inserted directly: public.profiles
// carries no FK to auth.users, and none of these tests signs in through
// GoTrue (the RLS probes run as the `authenticated` role with spoofed claims).
//
// Teardown order matters: pets first (cascading pet_events under the
// append-only escape hatch, and visits), then memberships and ownerships'
// dependents, then organizations (visits.organization_id is RESTRICT), then
// profiles.

import { randomUUID } from "node:crypto";

import { inArray } from "drizzle-orm";

import {
  db,
  organizationMemberships,
  organizations,
  ownerships,
  pets,
  profiles,
  visits,
} from "@/db";
import { withMutationOverride } from "./db-overrides";

export type VisitFixtures = {
  suffix: string;
  profileIds: string[];
  orgIds: string[];
  petIds: string[];
};

export function newVisitFixtures(): VisitFixtures {
  return {
    suffix: Math.random().toString(36).slice(2, 8).toUpperCase(),
    profileIds: [],
    orgIds: [],
    petIds: [],
  };
}

export async function makeProfile(fx: VisitFixtures, label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(profiles).values({ id, displayName: `Visitas ${label} ${fx.suffix}` });
  fx.profileIds.push(id);
  return id;
}

export async function makeOrg(fx: VisitFixtures, label: string): Promise<string> {
  const [row] = await db
    .insert(organizations)
    .values({
      publicToken: `VISIT-ORG-${fx.suffix}-${label}`,
      legalName: `Clinica Visitas ${label} ${fx.suffix}`,
      displayName: `Clinica Visitas ${label} ${fx.suffix}`,
      orgType: "clinic",
      email: `visitas-${label.toLowerCase()}-${fx.suffix.toLowerCase()}@example.test`,
    })
    .returning({ id: organizations.id });
  fx.orgIds.push(row.id);
  return row.id;
}

export async function makePet(fx: VisitFixtures, label: string): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({
      publicToken: `VISIT-${fx.suffix}-${label}`,
      name: `Visita ${label}`,
      species: "dog",
    })
    .returning({ id: pets.id });
  fx.petIds.push(row.id);
  return row.id;
}

export async function addMembership(
  organizationId: string,
  userId: string,
  opts: { left?: boolean } = {},
): Promise<void> {
  await db.insert(organizationMemberships).values({
    organizationId,
    userId,
    role: "member",
    canWritePetEvents: true,
    leftAt: opts.left ? new Date() : null,
  });
}

export async function addOwnership(
  petId: string,
  ownerUserId: string,
  opts: { ended?: boolean } = {},
): Promise<void> {
  await db.insert(ownerships).values({
    petId,
    ownerUserId,
    role: "owner",
    endedAt: opts.ended ? new Date() : null,
  });
}

export async function insertVisit(values: typeof visits.$inferInsert): Promise<string> {
  const [row] = await db.insert(visits).values(values).returning({ id: visits.id });
  return row.id;
}

export async function teardownVisitFixtures(fx: VisitFixtures): Promise<void> {
  if (fx.petIds.length > 0) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(inArray(pets.id, fx.petIds));
    });
  }
  if (fx.orgIds.length > 0) {
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.organizationId, fx.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, fx.orgIds));
  }
  if (fx.profileIds.length > 0) {
    await db
      .delete(organizationMemberships)
      .where(inArray(organizationMemberships.userId, fx.profileIds));
    await db.delete(profiles).where(inArray(profiles.id, fx.profileIds));
  }
}
