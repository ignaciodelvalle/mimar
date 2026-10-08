// Fixtures for the P4 found-animal tests (migration 0292).
//
// Every row is keyed by a per-file prefix, a per-run random suffix and fresh
// UUIDs, so keys never collide and teardown deletes exactly what this run
// wrote. Keys are not lists, though: a crashed run's orgs at the same place
// WOULD enter a later run's results, so a file that asserts a whole list calls
// sweepLeftovers(prefix) first. Profiles are inserted directly (public.profiles
// carries no FK to auth.users; the RLS probes run as `authenticated` with
// spoofed claims). Intake rows are written through the production writer,
// because the table's audit trigger refuses a write with no actor.
//
// Teardown: organizations first (the intake row cascades; audit rows keep
// their history with target_organization_id set NULL, which 0182 allows), then
// memberships and profiles.

import { randomUUID } from "node:crypto";

import { inArray, like } from "drizzle-orm";

import { db, organizationMemberships, organizations, profiles } from "@/db";
import {
  FOUND_ANIMAL_INTAKE_OFF,
  type FoundAnimalIntakeSettings,
} from "@/src/modules/organizations/domain/found-animal-intake";
import { upsertFoundAnimalIntake } from "@/src/modules/organizations/infrastructure/found-animal-intake-write";

type OrgType = (typeof organizations.orgType.enumValues)[number];

export type FoundAnimalFixtures = {
  /** Token prefix, one per test FILE, so a file may sweep its own leftovers. */
  prefix: string;
  suffix: string;
  profileIds: string[];
  orgIds: string[];
};

export function newFoundAnimalFixtures(prefix: string): FoundAnimalFixtures {
  return {
    prefix,
    suffix: Math.random().toString(36).slice(2, 8).toUpperCase(),
    profileIds: [],
    orgIds: [],
  };
}

export async function makeProfile(fx: FoundAnimalFixtures, label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(profiles).values({ id, displayName: `Receptoras ${label} ${fx.suffix}` });
  fx.profileIds.push(id);
  return id;
}

export type OrgSpec = {
  label: string;
  orgType?: OrgType;
  verified?: boolean;
  status?: "active" | "suspended" | "dissolved";
  publicDirectoryOptIn?: boolean;
  /** The org's pin; omit for an org with no coordinates. */
  at?: { lat: number; lng: number };
  province?: string;
  locality?: string;
};

export async function makeOrg(fx: FoundAnimalFixtures, spec: OrgSpec): Promise<string> {
  const [row] = await db
    .insert(organizations)
    .values({
      publicToken: `${fx.prefix}-${fx.suffix}-${spec.label}`,
      legalName: `Razon Social Privada ${spec.label} ${fx.suffix}`,
      displayName: `Receptora ${spec.label} ${fx.suffix}`,
      orgType: spec.orgType ?? "shelter",
      cuit: null,
      email: `privado-${spec.label.toLowerCase()}-${fx.suffix.toLowerCase()}@example.test`,
      phone: "+54 11 0000-0000",
      verified: spec.verified ?? true,
      status: spec.status ?? "active",
      publicDirectoryOptIn: spec.publicDirectoryOptIn ?? false,
      jurisdictionProvince: spec.province ?? null,
      jurisdictionLocality: spec.locality ?? null,
      locationLat: spec.at ? spec.at.lat.toFixed(7) : null,
      locationLng: spec.at ? spec.at.lng.toFixed(7) : null,
    })
    .returning({ id: organizations.id });
  fx.orgIds.push(row.id);
  return row.id;
}

export async function addMembership(
  organizationId: string,
  userId: string,
  opts: { role?: "admin" | "member"; left?: boolean } = {},
): Promise<void> {
  await db.insert(organizationMemberships).values({
    organizationId,
    userId,
    role: opts.role ?? "member",
    leftAt: opts.left ? new Date() : null,
  });
}

/** Writes the intake row through the production writer (audited, actor set). */
export async function setIntake(
  organizationId: string,
  actorUserId: string,
  settings: Partial<FoundAnimalIntakeSettings>,
): Promise<void> {
  await upsertFoundAnimalIntake(
    organizationId,
    { ...FOUND_ANIMAL_INTAKE_OFF, accepting: true, ...settings },
    actorUserId,
  );
}

export async function teardownFoundAnimalFixtures(fx: FoundAnimalFixtures): Promise<void> {
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

/**
 * Deletes what a CRASHED earlier run of the same file left behind (its
 * afterAll never ran). Only this file's prefix: another file's fixtures may be
 * live in a parallel worker. Without it, leftovers at the same coordinates and
 * province would enter this run's lists and every later run would fail.
 */
export async function sweepLeftovers(prefix: string): Promise<void> {
  const leftovers = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(like(organizations.publicToken, `${prefix}-%`));
  if (leftovers.length === 0) return;
  const ids = leftovers.map((r) => r.id);
  await db
    .delete(organizationMemberships)
    .where(inArray(organizationMemberships.organizationId, ids));
  await db.delete(organizations).where(inArray(organizations.id, ids));
}
