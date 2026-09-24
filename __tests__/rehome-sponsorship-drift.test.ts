// Non-vacuity control for the orphaned-sponsorship arm of lint:spine
// (rehome-by-titular; WU3 review, carry-forward #2 into WU4).
//
// THE DRIFT THIS HARNESS EXISTS FOR
// ---------------------------------------------------------------------------
// A rehome sponsorship is a spine fact: `rehome_sponsorship_started` names the
// `ownerships(role='shelter_custody')` row it opened, and the arrangement is
// "running" until a `rehome_sponsorship_ended` with the same ownership_id
// lands. The custody row is a CACHE of that fact. Every hand-off that closes
// the row is supposed to write the closing event in the same transaction
// (lib/infra/end-pet-ownerships.ts); `endAllLiveOwnerships` explicitly
// declines to paper over a row that was ALREADY closed by someone else and
// defers it to "the harness" — and until now no harness looked. An orphan of
// this shape keeps REQ-16 refusing every future request on the pet ("ya tiene
// una organización acompañando") with nothing left for the titular to
// withdraw, and makes the rollback script (ADR-7) "end" an arrangement that
// ended months earlier onto whoever holds the animal by then.
//
// The gate itself is scripts/check-spine-integrity.ts (`pnpm lint:spine`),
// blocking with no baseline, same as its pet_registered arm. THIS FILE proves
// the query can SEE an orphan: a fence that has only ever returned zero is
// indistinguishable from one that cannot look. Both drift shapes are planted
// (row ended, row missing), the non-orphan shapes are planted next to them
// (row live; row ended but the ended event written), and everything is
// removed in afterAll.
//
// `db` vitest project (serial): the claim is about real rows in real tables.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizations, ownerships, petEvents, pets } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { DEFAULT_LOCAL_URL } from "@/scripts/_db-target";
import { queryOrphanedSponsorships } from "@/scripts/check-spine-integrity";

import { withMutationOverride } from "./_helpers/db-overrides";

const ORG_TOKEN = "DIM-RSDR-ORG1";
const PET_LIVE = "DIM-RSDR-LIVE";
const PET_ENDED = "DIM-RSDR-ENDD";
const PET_MISSING = "DIM-RSDR-MISS";
const PET_HEALED = "DIM-RSDR-HEAL";
const ALL_PET_TOKENS = [PET_LIVE, PET_ENDED, PET_MISSING, PET_HEALED];

const pgSql = postgres(process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL, {
  max: 1,
  connect_timeout: 5,
});

let orgId: string;
let endedCustodyId: string;
let healedCustodyId: string;

async function purge(): Promise<void> {
  await withMutationOverride(async (tx) => {
    for (const token of ALL_PET_TOKENS) {
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
        SELECT id FROM pets WHERE public_token = ${token}
      )`);
      await tx.execute(sql`DELETE FROM pets WHERE public_token = ${token}`);
    }
    await tx.execute(sql`DELETE FROM organizations WHERE public_token = ${ORG_TOKEN}`);
  });
}

/** A pet with a custody row and an unmatched `rehome_sponsorship_started` naming it. */
async function plantSponsoredPet(args: {
  token: string;
  name: string;
  /** `null` leaves the row live; a Date closes it. */
  endedAt: Date | null;
  /** When set, the started event names THIS id instead of the real row (the "missing" shape). */
  ownershipIdOverride?: string;
}): Promise<{ petId: string; custodyId: string }> {
  const now = new Date();
  return withMutationOverride(async (tx) => {
    const [pet] = await tx
      .insert(pets)
      .values({ publicToken: args.token, name: args.name, species: "dog", sex: "female" })
      .returning({ id: pets.id });
    const [custody] = await tx
      .insert(ownerships)
      .values({
        petId: pet.id,
        ownerOrganizationId: orgId,
        role: "shelter_custody",
        startedAt: now,
        endedAt: args.endedAt,
      })
      .returning({ id: ownerships.id });
    await tx.insert(petEvents).values({
      petId: pet.id,
      eventType: "rehome_sponsorship_started",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: null,
      authorRole: "shelter",
      authorOrganizationId: orgId,
      authorVerified: true,
      payload: validateEventPayload("rehome_sponsorship_started", {
        ownership_id: args.ownershipIdOverride ?? custody.id,
        sponsoring_organization_id: orgId,
        consented_by_user_id: randomUUID(),
        request_case_public_code: "CAS-RSDR-0001",
        listing_case_id: null,
        note: null,
      }),
    });
    return { petId: pet.id, custodyId: custody.id };
  });
}

beforeAll(async () => {
  await purge();
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Refugio Drift SRL",
      displayName: "Refugio Drift",
      orgType: "shelter",
      email: "rsdr-org@dim-test.local",
      verified: true,
    })
    .returning({ id: organizations.id });
  orgId = org.id;

  // The four shapes, side by side. Only two of them are drift.
  await plantSponsoredPet({ token: PET_LIVE, name: "Drift Live", endedAt: null });
  endedCustodyId = (
    await plantSponsoredPet({ token: PET_ENDED, name: "Drift Ended", endedAt: new Date() })
  ).custodyId;
  await plantSponsoredPet({
    token: PET_MISSING,
    name: "Drift Missing",
    endedAt: new Date(),
    ownershipIdOverride: randomUUID(),
  });
  healedCustodyId = (
    await plantSponsoredPet({ token: PET_HEALED, name: "Drift Healed", endedAt: new Date() })
  ).custodyId;
});

afterAll(async () => {
  await purge();
  await pgSql.end({ timeout: 1 }).catch(() => {});
});

async function planted() {
  const rows = await queryOrphanedSponsorships(pgSql);
  return rows.filter((r) => ALL_PET_TOKENS.includes(r.public_token));
}

describe("lint:spine — orphaned rehome sponsorships (started, never ended, custody row gone)", () => {
  it("reports the planted orphans and names which shape each one is — and ignores the live one", async () => {
    const rows = await planted();
    const byToken = new Map(rows.map((r) => [r.public_token, r]));

    // NON-VACUITY: the two drift shapes are seen, with the row they point at.
    expect(byToken.get(PET_ENDED)).toMatchObject({
      ownership_id: endedCustodyId,
      organization_id: orgId,
      row_state: "ended",
    });
    expect(byToken.get(PET_MISSING)).toMatchObject({
      organization_id: orgId,
      row_state: "missing",
    });

    // A RUNNING sponsorship — live row, unmatched started event — is the normal
    // state between accept and finalize/withdraw, not drift.
    expect(byToken.has(PET_LIVE)).toBe(false);

    // Not yet healed: its row is ended and nothing on the spine says so.
    expect(byToken.has(PET_HEALED)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("stops reporting a pet once the matching rehome_sponsorship_ended is on the spine", async () => {
    const now = new Date();
    const [pet] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_HEALED));
    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "rehome_sponsorship_ended",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: null,
      authorRole: "shelter",
      authorOrganizationId: orgId,
      authorVerified: true,
      payload: validateEventPayload("rehome_sponsorship_ended", {
        ownership_id: healedCustodyId,
        outcome: "withdrawn_by_platform",
        ended_at: now.toISOString(),
      }),
    });

    const rows = await planted();
    expect(rows.map((r) => r.public_token).sort()).toEqual([PET_ENDED, PET_MISSING]);
  });

  it("an ended event for a DIFFERENT custody row does not heal the orphan — the match is by ownership_id", async () => {
    const now = new Date();
    const [pet] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_ENDED));
    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "rehome_sponsorship_ended",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: null,
      authorRole: "shelter",
      authorOrganizationId: orgId,
      authorVerified: true,
      payload: validateEventPayload("rehome_sponsorship_ended", {
        ownership_id: randomUUID(),
        outcome: "withdrawn_by_platform",
        ended_at: now.toISOString(),
      }),
    });

    const rows = await planted();
    expect(rows.map((r) => r.public_token).sort()).toEqual([PET_ENDED, PET_MISSING]);
  });
});
