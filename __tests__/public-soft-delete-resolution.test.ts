// PO-4 (2026-08-05) — an erased subject's pet stops resolving publicly.
//
// Erasure (Ley 25.326 art. 16) soft-deletes the pets in the subject's custody:
// `erase_subject_data` sets `pets.deleted_at` and leaves the row in place so
// the append-only spine survives. Every public surface, though, resolved the
// token with a bare `eq(pets.public_token, …)`, so the credential kept
// answering anyone who scanned the QR. The physical chapa (/t/[serial] → 307
// → /p) made that pre-existing behavior reachable from a durable object.
//
// The four things this file proves, against the REAL RPC and a real DB:
//
//   1. The erasure soft-deletes the pet still in the subject's custody and
//      does NOT touch a pet transferred away BEFORE the erasure. That
//      asymmetry is the whole PO-4 decision: the credential belongs to the
//      ANIMAL (invariant #1), so it goes dark only when the animal's own row
//      is erased — never because a previous owner exercised their rights.
//   2. `publicPetByToken` — the one predicate every ungated public surface now
//      resolves through — drops the erased pet and keeps the transferred one.
//   3. `lookupTagBySerial` returns NO destination for an ACTIVE chapa whose
//      pet was erased, so /t/[serial] can render its honest neutral state
//      instead of 307-ing a person in the street into a 404.
//   4. `resolvePetHolderAccess` — the choke point all authenticated pet
//      surfaces resolve through, web and API — answers `{ kind: "none" }` for
//      the erased pet on BOTH of its paths, even though the erasure RPC leaves
//      every `ownerships` row alive. This is the runtime fence on the art. 16
//      filter inside the resolver; the mocked `pet-access.test.ts` discards
//      `.where()` predicates and cannot see it.
//
// The page-level side of (3) — what the scanner actually reads — lives in
// tag-resolver-page.test.tsx, which drives the resolver's four-state matrix
// over a mocked lookup.
//
// The static sweep at the bottom is the fence that matters most: the failure
// mode here is a NEW public route that simply forgets the filter, and a
// forgotten filter looks exactly like a present one until someone scans a
// token that should be gone. It is a RULE over derived reachability and no
// longer a hand-kept list of routes — see the long note above it for what that
// list missed, and for what the rule still cannot see.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  db,
  libretaShareTokens,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  petIdentifications,
  petTags,
  pets,
  profiles,
} from "@/db";
import { fetchOrgCensus } from "@/lib/analytics/org-census";
import {
  fetchActiveAdoptions,
  fetchAvailableForAdoption,
  fetchIntakesLastWeek,
  fetchOrgQueueCounts,
  fetchOrgQueueSignals,
  fetchRequiresAction,
} from "@/lib/analytics/org-dashboard";
import { lookupByChip } from "@/lib/infra/chip-lookup";
import { generateIntakeMatchClaim } from "@/lib/infra/intake-match-claim";
import { resolvePetHolderAccess } from "@/lib/infra/pet-access";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { generateTagActivationCode, generateTagSerial } from "@/lib/infra/publicToken";
import { lookupTagBySerial } from "@/lib/infra/tag-lookup";
import { lookupByTattoo } from "@/lib/infra/tattoo-lookup";
import { replayPetMicrochip } from "@/lib/projections/pet-microchip";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";
import { releaseMicrochipsForErasedPets } from "@/src/modules/auth/application/subject-rights/erase-subject-data";
import { FosterRepository } from "@/src/modules/foster/infrastructure/foster-repository";
import { confirmChipMatchAsRefugioWriter } from "@/src/modules/pets/application/chip-match/confirm-chip-match-refugio";
import { confirmChipMatchAsVecinoWriter } from "@/src/modules/pets/application/chip-match/confirm-chip-match-vecino";
import { lookupForClaimForUser } from "@/src/modules/pets/application/claim/lookup-for-claim";
import { RehomeRepository } from "@/src/modules/rehome/infrastructure/rehome-repository";
import { actorCancelProposalUseCase } from "@/src/modules/return-to-owner/application/actor-cancel-proposal";
import { orgAcceptOwnerReturnUseCase } from "@/src/modules/return-to-owner/application/org-accept-owner-return";
import { orgRejectOwnerReturnUseCase } from "@/src/modules/return-to-owner/application/org-reject-owner-return";
import { ownerAcceptReturnUseCase } from "@/src/modules/return-to-owner/application/owner-accept-return";
import { ownerProposeReturnToOrgUseCase } from "@/src/modules/return-to-owner/application/owner-propose-return-to-org";
import { ownerRejectReturnUseCase } from "@/src/modules/return-to-owner/application/owner-reject-return";
import { proposeReturnAsRefugioUseCase } from "@/src/modules/return-to-owner/application/propose-return-as-refugio";
import { proposeReturnAsVecinoUseCase } from "@/src/modules/return-to-owner/application/propose-return-as-vecino";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";
import { ROOT, directDeps } from "./db-reachability";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const PASS = "SoftDelete_2026!";

const ERASED_EMAIL = "po4-erased@dim-test.local";
const KEEPER_EMAIL = "po4-keeper@dim-test.local";
const SPONSOR_EMAIL = "po4-sponsor@dim-test.local";

const TOKEN_ERASED = "DIM-PO4E-RASE";
const TOKEN_MOVED = "DIM-PO4M-OVED";
// Secondary identifiers (range-5 unit): erasure leaves the chip/tattoo rows
// `active` in pet_identifications (migration 0207 has no statements over that
// table), so the LOOKUPS carry the art. 16 filter — these codes exist to prove
// it. Both cascade away with the pets in cleanup().
const CHIP_ERASED = "981098109810001";
const CHIP_MOVED = "981098109810002";
const TATTOO_ERASED = "PO4TATERASED";
const TATTOO_MOVED = "PO4TATMOVED";
// Reunification unit: a throwaway pet that re-claims the erased chip's code
// AFTER the release, proving the code is free again. Cleaned up with the others.
const TOKEN_RECLAIM = "DIM-PO4R-CLM1";
const TEST_LOTE = "TEST-LOTE-PO4";
const ORG_TOKEN = "ORG-PO4S-PONS";

const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

// The ONLY mock in this real-DB file, and it is deliberately surgical: the admin
// microchip-replacement server action opens with `requireAdminOrRedirect()`,
// which needs a request scope vitest does not have. Everything the action then
// does — resolving the pet, reading the canonical identifiers, refusing — runs
// against the real Postgres and the real post-erasure fixtures, so the guard
// under test is never the mocked half. `importOriginal` keeps every other export
// real: nothing else in this file's graph may change behaviour because of it.
const adminActor = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/infra/auth-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/auth-guards")>();
  return {
    ...actual,
    requireAdminOrRedirect: async () => ({
      user: { id: adminActor.id },
      profile: {
        id: adminActor.id,
        role: "admin",
        accountType: "personal",
        deactivatedAt: null,
      },
    }),
  };
});

let erasedUserId: string;
let keeperUserId: string;
let sponsorUserId: string;
let sponsorOrgId: string;
let erasedPetId: string;
let movedPetId: string;
let serialErased: string;
let serialMoved: string;
let erasedShareId: string;
let keeperShareId: string;

// Auth users are REUSED across runs (audit_log points back at actor_user_id
// with ON DELETE RESTRICT, so delete-and-recreate breaks on the second run —
// same reasoning as subject-rights-rpcs.test.ts).
async function ensureUser(email: string): Promise<string> {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === email);
  if (found) return found.id;
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  return data.user.id;
}

async function insertPet(publicToken: string, name: string): Promise<string> {
  const [row] = await db
    .insert(pets)
    .values({ publicToken, name, species: "dog", sex: "female", status: "active" })
    .returning({ id: pets.id });
  return row.id;
}

async function activateTagFor(petId: string, userId: string): Promise<string> {
  const serial = generateTagSerial();
  await db.insert(petTags).values({
    serial,
    activationCodeHash: hashTagActivationCode(generateTagActivationCode()),
    loteId: TEST_LOTE,
    status: "active",
    petId,
    activatedByUserId: userId,
    activatedAt: new Date(),
  });
  return serial;
}

async function cleanup() {
  await db.delete(petTags).where(eq(petTags.loteId, TEST_LOTE));
  // Pets FIRST (their cascade removes pet_events under the override), org
  // AFTER: the org's ON DELETE SET NULL on pet_events.author_organization_id
  // is an UPDATE the append-only trigger blocks, so deleting the org while
  // any fixture event still names it aborts the whole cleanup.
  await withMutationOverride(async (tx) => {
    for (const token of [TOKEN_ERASED, TOKEN_MOVED, TOKEN_RECLAIM]) {
      const stale = await tx.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
      for (const { id } of stale) await tx.delete(pets).where(eq(pets.id, id));
    }
  });
  // The org cascades its memberships and any leftover ownership rows.
  await db.delete(organizations).where(eq(organizations.publicToken, ORG_TOKEN));
}

beforeAll(async () => {
  await cleanup();

  erasedUserId = await ensureUser(ERASED_EMAIL);
  keeperUserId = await ensureUser(KEEPER_EMAIL);
  // The actor the mocked admin guard hands the microchip action. It must be a
  // LIVE auth user because the action's success path writes an event authored by
  // it; the erased subject would be the wrong choice for exactly that reason.
  adminActor.id = keeperUserId;

  // The erasure RPC is not idempotent across runs from the test's point of
  // view (it soft-deletes the profile), so reset the subject to a live state.
  await db
    .update(profiles)
    .set({ displayName: "PO4 Erased Subject", deletedAt: null, updatedAt: new Date() })
    .where(eq(profiles.id, erasedUserId));
  await db
    .update(profiles)
    .set({ displayName: "PO4 Keeper", deletedAt: null, updatedAt: new Date() })
    .where(eq(profiles.id, keeperUserId));

  // Pet 1 — still in the erasing subject's custody at erasure time.
  erasedPetId = await insertPet(TOKEN_ERASED, "PO4 Erased Pet");
  await db.insert(ownerships).values({
    petId: erasedPetId,
    ownerUserId: erasedUserId,
    role: "owner",
  });

  // Pet 2 — transferred AWAY before the erasure: the subject's ownership row
  // is closed and the keeper holds the live one.
  movedPetId = await insertPet(TOKEN_MOVED, "PO4 Moved Pet");
  await db.insert(ownerships).values({
    petId: movedPetId,
    ownerUserId: erasedUserId,
    role: "owner",
    endedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  await db.insert(ownerships).values({
    petId: movedPetId,
    ownerUserId: keeperUserId,
    role: "owner",
  });

  serialErased = await activateTagFor(erasedPetId, erasedUserId);
  serialMoved = await activateTagFor(movedPetId, keeperUserId);

  // Sponsor org with a live shelter_custody row on BOTH pets, seeded BEFORE
  // the erasure. Rehome (design R4) is why this population exists: the org
  // only publishes and vets while the animal keeps living with its family, so
  // the family's owner row and the org's custody row are live at the same
  // time — and `erase_subject_data` contains zero statements over
  // `ownerships`, so the sponsorship SURVIVES the erasure. Org members are
  // the one live population that still reaches resolvePetHolderAccess for an
  // erased pet (the erased owner is stopped earlier by requireLiveUser).
  sponsorUserId = await ensureUser(SPONSOR_EMAIL);
  await db
    .update(profiles)
    .set({ displayName: "PO4 Sponsor Member", deletedAt: null, updatedAt: new Date() })
    .where(eq(profiles.id, sponsorUserId));
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Refugio PO4 Sponsor",
      displayName: "Refugio PO4 Sponsor",
      orgType: "shelter",
      email: "refugio-po4@dim-test.local",
    })
    .returning({ id: organizations.id });
  await db.insert(organizationMemberships).values({
    organizationId: org.id,
    userId: sponsorUserId,
    role: "member",
  });
  await db.insert(ownerships).values([
    { petId: erasedPetId, ownerOrganizationId: org.id, role: "shelter_custody" },
    { petId: movedPetId, ownerOrganizationId: org.id, role: "shelter_custody" },
  ]);

  sponsorOrgId = org.id;

  // A SECOND live person row on the soon-to-be-erased pet. The erasure only
  // soft-deletes pets where the SUBJECT holds the live 'owner' row; other
  // people's rows on that pet are untouched, so this one also survives.
  await db.insert(ownerships).values({
    petId: erasedPetId,
    ownerUserId: keeperUserId,
    role: "co_owner",
  });

  // ------------------------------------------------------------------------
  // Art. 16 follow-up fixtures (thirteen-surfaces unit). Everything below is
  // seeded BEFORE the erasure so the tests read what an org member (or a
  // share-link holder) would actually see the morning after.
  // ------------------------------------------------------------------------

  // Both pets adoption-eligible: the "Disponibles" KPI population. The check
  // constraint pairs adoption_eligible with adoption_eligibility_set_at.
  await db
    .update(pets)
    .set({ adoptionEligible: true, adoptionEligibilitySetAt: new Date() })
    .where(inArray(pets.id, [erasedPetId, movedPetId]));

  // One open adoption application + one fresh intake per pet, so each org
  // KPI has exactly one row on each side of the erasure line.
  const now = new Date();
  // The ERASED pet's application is 10 days OLDER than the live one on
  // purpose: signalActiveAdoptions reports the age of the OLDEST pending
  // application, so with the art. 16 filter the signal reads 0 days (the live
  // pet's) and with the filter reverted it reads 10 (the erased pet's) — the
  // asymmetry is what makes that pin mutation-sensitive.
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  await db.insert(petEvents).values([
    {
      petId: erasedPetId,
      eventType: "adoption_application_submitted",
      occurredAt: tenDaysAgo,
      recordedByUserId: keeperUserId,
      payload: { applicant_user_id: keeperUserId, housing_type: "house" },
    },
    {
      petId: movedPetId,
      eventType: "adoption_application_submitted",
      occurredAt: now,
      recordedByUserId: keeperUserId,
      payload: { applicant_user_id: keeperUserId, housing_type: "house" },
    },
    {
      petId: erasedPetId,
      eventType: "shelter_intake_recorded",
      occurredAt: now,
      recordedByUserId: sponsorUserId,
      authorRole: "shelter",
      authorOrganizationId: sponsorOrgId,
      payload: {},
    },
    {
      petId: movedPetId,
      eventType: "shelter_intake_recorded",
      occurredAt: now,
      recordedByUserId: sponsorUserId,
      authorRole: "shelter",
      authorOrganizationId: sponsorOrgId,
      payload: {},
    },
  ]);

  // ------------------------------------------------------------------------
  // Custody-writers unit fixtures (art. 16 follow-up #2). Also seeded BEFORE
  // the erasure: ownerships and pet_events survive it by design, so these
  // rows are exactly the survivors the counters read the morning after.
  // ------------------------------------------------------------------------

  // A live foster row on each pet: countActiveFosters' population is custody
  // rows that ALSO carry a live foster. The holder is the soon-to-be-erased
  // subject on purpose — erasure never touches ownerships (#899 scoped it to
  // role='owner' PETS, not rows), and no other test resolves this user.
  await db.insert(ownerships).values([
    { petId: erasedPetId, ownerUserId: erasedUserId, role: "foster" },
    { petId: movedPetId, ownerUserId: erasedUserId, role: "foster" },
  ]);

  // One vaccination per pet whose next dose is overdue: fetchRequiresAction's
  // overdue_vaccine flag, on both sides of the erasure line.
  await db.insert(petEvents).values([
    {
      petId: erasedPetId,
      eventType: "vaccination_administered",
      occurredAt: tenDaysAgo,
      recordedByUserId: sponsorUserId,
      proximaDosisAt: "2026-01-01",
      payload: { vaccine_name: "Sextuple" },
    },
    {
      petId: movedPetId,
      eventType: "vaccination_administered",
      occurredAt: tenDaysAgo,
      recordedByUserId: sponsorUserId,
      proximaDosisAt: "2026-01-01",
      payload: { vaccine_name: "Sextuple" },
    },
  ]);

  // Libreta shares: the subject's NON-EXPIRING share on their own pet (the
  // exact artifact the erasure left serving before 0207), and the keeper's
  // share on the live pet (the control that proves the revocation is scoped).
  const [erasedShare] = await db
    .insert(libretaShareTokens)
    .values({
      shareToken: "po4-erased-share-token",
      petId: erasedPetId,
      createdByUserId: erasedUserId,
      expiresAt: null,
    })
    .returning({ id: libretaShareTokens.id });
  erasedShareId = erasedShare.id;
  const [keeperShare] = await db
    .insert(libretaShareTokens)
    .values({
      shareToken: "po4-keeper-share-token",
      petId: movedPetId,
      createdByUserId: keeperUserId,
      expiresAt: null,
    })
    .returning({ id: libretaShareTokens.id });
  keeperShareId = keeperShare.id;

  // Secondary identifiers, seeded BEFORE the erasure: an active chip and an
  // active tattoo on each pet. The erasure touches neither row — what must
  // change is what the lookups answer.
  await db.insert(petIdentifications).values([
    { petId: erasedPetId, kind: "microchip_iso", code: CHIP_ERASED, status: "active" },
    { petId: movedPetId, kind: "microchip_iso", code: CHIP_MOVED, status: "active" },
    { petId: erasedPetId, kind: "tattoo", code: TATTOO_ERASED, status: "active" },
    { petId: movedPetId, kind: "tattoo", code: TATTOO_MOVED, status: "active" },
  ]);

  // A microchip_implanted event for the erased pet's chip, so the append-only
  // spine actually CARRIES the implant the release must retract. Without it the
  // drift-replay proof in the reunification unit below would be vacuous (nothing
  // for the revocation event to fold against).
  await db.insert(petEvents).values({
    petId: erasedPetId,
    eventType: "microchip_implanted",
    occurredAt: tenDaysAgo,
    recordedByUserId: erasedUserId,
    payload: { chip_number: CHIP_ERASED, country_code: "981", implant_date_known: false },
  });

  // The real thing: the subject exercises art. 16.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: erasedUserId })}, true)`,
    );
    await tx.execute(
      sql`SELECT public.erase_subject_data(${erasedUserId}::uuid, 'PO4 resolution test'::text)`,
    );
  });
}, 60_000);

afterAll(async () => {
  await cleanup();
}, 30_000);

describe("erase_subject_data — which pets go dark (PO-4)", () => {
  it("soft-deletes the pet in the subject's custody", async () => {
    const [row] = await db
      .select({ deletedAt: pets.deletedAt })
      .from(pets)
      .where(eq(pets.id, erasedPetId));
    expect(row.deletedAt).not.toBeNull();
  });

  it("leaves a pet transferred away BEFORE the erasure untouched", async () => {
    // The overreach guard. If this ever flips, an ex-owner exercising their
    // rights would switch off a credential that belongs to someone else's
    // animal — the exact scenario the PO called out when deciding PO-4.
    const [row] = await db
      .select({ deletedAt: pets.deletedAt })
      .from(pets)
      .where(eq(pets.id, movedPetId));
    expect(row.deletedAt).toBeNull();
  });
});

describe("publicPetByToken — the shared public-resolution predicate (PO-4)", () => {
  it("resolves nothing for the erased pet", async () => {
    const rows = await db.select({ id: pets.id }).from(pets).where(publicPetByToken(TOKEN_ERASED));
    expect(rows).toHaveLength(0);
  });

  it("still resolves the transferred pet", async () => {
    const rows = await db.select({ id: pets.id }).from(pets).where(publicPetByToken(TOKEN_MOVED));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(movedPetId);
  });
});

describe("/t/[serial] lookup — an active chapa never points at an erased pet (PO-4)", () => {
  it("returns the active status with NO destination for the erased pet", async () => {
    // Status stays 'active' — the chapa was never revoked, and lying about
    // that would send its owner into the activation flow. What disappears is
    // the destination, which is what stops the 307-into-404.
    const result = await lookupTagBySerial(serialErased);
    expect(result).toEqual({ status: "active", publicToken: null });
  });

  it("keeps resolving the transferred pet's chapa", async () => {
    expect(await lookupTagBySerial(serialMoved)).toEqual({
      status: "active",
      publicToken: TOKEN_MOVED,
    });
  });

  it("the pet_tags row itself is untouched by the erasure", async () => {
    const [row] = await db
      .select({ status: petTags.status, petId: petTags.petId })
      .from(petTags)
      .where(eq(petTags.serial, serialErased));
    expect(row.status).toBe("active");
    expect(row.petId).toBe(erasedPetId);
  });
});

describe("resolvePetHolderAccess — an erased pet resolves no holder access (art. 16)", () => {
  // THE RUNTIME FENCE on the `isNull(pets.deletedAt)` term inside the
  // resolver, and the only test that can see it: `pet-access.test.ts` mocks
  // the query chain and its `.where()` discards the predicate, so a mocked
  // case there would stay green with the filter deleted. These run the real
  // query against the real post-erasure rows. Both paths are pinned, because
  // each has its own predicate and fixing one does not fix the other.

  it("org path: a surviving shelter_custody sponsorship resolves { kind: 'none' }", async () => {
    expect(await resolvePetHolderAccess(TOKEN_ERASED, sponsorUserId)).toEqual({ kind: "none" });
  });

  it("owner path: a surviving live person row resolves { kind: 'none' }", async () => {
    expect(await resolvePetHolderAccess(TOKEN_ERASED, keeperUserId)).toEqual({ kind: "none" });
  });

  it("non-vacuity: both paths still resolve the live pet", async () => {
    // Without these, a resolver that answered "none" to everything would pass
    // the two refusals above.
    const owner = await resolvePetHolderAccess(TOKEN_MOVED, keeperUserId);
    expect(owner.kind).toBe("owner");
    const viaOrg = await resolvePetHolderAccess(TOKEN_MOVED, sponsorUserId);
    expect(viaOrg.kind).toBe("org");
  });
});

describe("org roster projections — an erased pet keeps no seat (art. 16 follow-up)", () => {
  // These call the REAL analytics functions over the post-erasure rows. Each
  // pair (erased pet excluded / live pet still counted) pins one caller-side
  // `pets.deleted_at` filter added by the thirteen-surfaces follow-up; the
  // live pet is the non-vacuity half — a projection answering 0 to everything
  // would fail it.

  it("fetchAvailableForAdoption counts only the live pet", async () => {
    // Both pets are adoption-eligible and in the org's live custody; only the
    // non-erased one may count — this is the KPI the mascotas list claims to
    // match, and the claim broke the day the list took the filter alone.
    expect(await fetchAvailableForAdoption(sponsorOrgId)).toBe(1);
  });

  it("fetchActiveAdoptions counts only the live pet's open application", async () => {
    expect(await fetchActiveAdoptions(sponsorOrgId)).toBe(1);
  });

  it("fetchIntakesLastWeek counts only the live pet's intake", async () => {
    expect(await fetchIntakesLastWeek(sponsorOrgId)).toBe(1);
  });

  it("fetchOrgCensus seats only the live pet", async () => {
    const census = await fetchOrgCensus(sponsorOrgId);
    expect(census.dogs + census.cats + census.other).toBe(1);
  });
});

describe("erase_subject_data — outstanding libreta shares die with the account (0207)", () => {
  // The share link serves the pet's full Tier-2 libreta, can be non-expiring,
  // and the erasure 404s every surface that could revoke it — so the RPC now
  // revokes it itself, the way it already cancels pending transfers. The
  // keeper's share on the live pet is the scope control.

  it("revokes the subject's non-expiring share on the erased pet", async () => {
    const [share] = await db
      .select({ revokedAt: libretaShareTokens.revokedAt })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.id, erasedShareId));
    expect(share.revokedAt).not.toBeNull();
  });

  it("leaves another holder's share on a live pet untouched", async () => {
    const [share] = await db
      .select({ revokedAt: libretaShareTokens.revokedAt })
      .from(libretaShareTokens)
      .where(eq(libretaShareTokens.id, keeperShareId));
    expect(share.revokedAt).toBeNull();
  });
});

describe("chip-match confirm — an erased pet reads as never-existed (shape B write)", () => {
  // The confirm writers append to a pet resolved by a bare token (the HMAC
  // claim authorizes the org, not the pet's continued existence). Both
  // decisions write onto the matched pet, so the erased one must refuse with
  // the same copy a nonexistent token gets — and write NOTHING.

  const sponsorAuth = () => ({
    user: { id: sponsorUserId },
    organization: { id: sponsorOrgId, displayName: "Refugio PO4 Sponsor", verified: false },
  });

  it("refugio writer refuses the erased pet with the never-existed copy and appends no event", async () => {
    const result = await confirmChipMatchAsRefugioWriter({
      auth: sponsorAuth(),
      orgToken: ORG_TOKEN,
      claim: generateIntakeMatchClaim(ORG_TOKEN, TOKEN_ERASED),
      matchedPetToken: TOKEN_ERASED,
      decision: "not_same",
    });
    expect(result).toEqual({ error: "Mascota no encontrada." });
    const notes = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, erasedPetId), eq(petEvents.eventType, "note_added")));
    expect(notes).toHaveLength(0);
  });

  it("non-vacuity: the live pet still resolves through the same writer", async () => {
    const result = await confirmChipMatchAsRefugioWriter({
      auth: sponsorAuth(),
      orgToken: ORG_TOKEN,
      claim: generateIntakeMatchClaim(ORG_TOKEN, TOKEN_MOVED),
      matchedPetToken: TOKEN_MOVED,
      decision: "not_same",
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("chip-match confirm vecino — pinned the day the 'not invocable from vitest' claim fell", () => {
  // The sibling refugio writer was mutation-proved above; this one was left
  // unpinned behind a claim that it could not be invoked from vitest. It takes
  // plain args like everything else in this file. The filter sits BEFORE the
  // chip-proof gate, so erased == never-existed even for a caller who cannot
  // produce the chip.

  it("refuses the erased pet with the never-existed copy, without a chip", async () => {
    const result = await confirmChipMatchAsVecinoWriter({
      userId: sponsorUserId,
      matchedPetToken: TOKEN_ERASED,
      attemptedMicrochipId: "999999999999999",
      decision: "not_same",
    });
    expect(result).toEqual({ error: "Mascota no encontrada." });
  });

  it("non-vacuity: the live pet passes resolution and fails on the chip proof instead", async () => {
    // Reverting the filter routes the erased pet here too — a different copy,
    // which is what turns the mutation red.
    const result = await confirmChipMatchAsVecinoWriter({
      userId: sponsorUserId,
      matchedPetToken: TOKEN_MOVED,
      attemptedMicrochipId: "999999999999999",
      decision: "not_same",
    });
    expect(result).toEqual({
      error:
        "No pudimos verificar la coincidencia de microchip. Volvé a ingresar el número y reintentá.",
    });
  });
});

describe("return-to-owner writers — an erased pet reads as never-existed (shape A write)", () => {
  // The ALTA of the custody-writers unit. propose-return-as-vecino is gated
  // only by a shelter_custody row and status='lost', BOTH of which survive
  // erasure — so before the filter, any ordinary live custodian could append
  // a custody_transfer_proposed event onto the erased spine AND fire an
  // urgent "Devolución propuesta de {name}" notification into the erased
  // owner's account, republishing the name the erasure retired. The family
  // resolves inline (not through a repository), which is how a
  // repository-shaped sweep missed it.
  //
  // Every writer resolves the token FIRST and each writer's SECOND gate uses
  // a different copy, so each refusal below is its own mutation tripwire:
  // revert one call site's filter and exactly that test answers the second
  // gate's copy instead.

  const NOT_FOUND = { error: "Mascota no encontrada." };
  const orgArgs = () => ({
    orgId: sponsorOrgId,
    orgDisplayName: "Refugio PO4 Sponsor",
    actingUserId: sponsorUserId,
  });

  it("propose-return-as-vecino refuses the erased pet", async () => {
    expect(
      await proposeReturnAsVecinoUseCase({
        userId: sponsorUserId,
        petPublicToken: TOKEN_ERASED,
        notes: null,
      }),
    ).toEqual(NOT_FOUND);
  });

  it("propose-return-as-refugio refuses the erased pet", async () => {
    expect(
      await proposeReturnAsRefugioUseCase({
        userId: sponsorUserId,
        organization: { id: sponsorOrgId, displayName: "Refugio PO4 Sponsor" },
        petPublicToken: TOKEN_ERASED,
        notes: null,
      }),
    ).toEqual(NOT_FOUND);
  });

  it("owner-propose-return-to-org refuses the erased pet", async () => {
    expect(
      await ownerProposeReturnToOrgUseCase({
        userId: keeperUserId,
        petPublicToken: TOKEN_ERASED,
        reason: "moving",
        notes: null,
        proposedAt: new Date().toISOString(),
      }),
    ).toEqual(NOT_FOUND);
  });

  it("owner-accept-return refuses the erased pet", async () => {
    expect(
      await ownerAcceptReturnUseCase({ userId: keeperUserId, petPublicToken: TOKEN_ERASED }),
    ).toEqual(NOT_FOUND);
  });

  it("owner-reject-return refuses the erased pet", async () => {
    expect(
      await ownerRejectReturnUseCase({
        userId: keeperUserId,
        petPublicToken: TOKEN_ERASED,
        reason: "no",
      }),
    ).toEqual(NOT_FOUND);
  });

  it("org-accept-owner-return refuses the erased pet", async () => {
    expect(
      await orgAcceptOwnerReturnUseCase({ ...orgArgs(), petPublicToken: TOKEN_ERASED }),
    ).toEqual(NOT_FOUND);
  });

  it("org-reject-owner-return refuses the erased pet", async () => {
    expect(
      await orgRejectOwnerReturnUseCase({
        ...orgArgs(),
        petPublicToken: TOKEN_ERASED,
        reason: "no",
      }),
    ).toEqual(NOT_FOUND);
  });

  it("actor-cancel-proposal refuses the erased pet", async () => {
    expect(
      await actorCancelProposalUseCase({
        userId: sponsorUserId,
        petPublicToken: TOKEN_ERASED,
        reason: "cancel",
      }),
    ).toEqual(NOT_FOUND);
  });

  it("non-vacuity: the live pet passes resolution and fails on the NEXT gate instead", async () => {
    // status='active' and no pending proposal, so a RESOLVED pet answers a
    // later gate's copy — proof the refusals above came from the token filter,
    // not from writers that refuse everything.
    expect(
      await proposeReturnAsVecinoUseCase({
        userId: sponsorUserId,
        petPublicToken: TOKEN_MOVED,
        notes: null,
      }),
    ).toEqual({ error: "La mascota no está en estado 'perdida' (estado actual: active)." });
    expect(
      await orgAcceptOwnerReturnUseCase({ ...orgArgs(), petPublicToken: TOKEN_MOVED }),
    ).toEqual({ error: "No hay propuesta de devolución pendiente para esta mascota." });
  });
});

describe("custody repository resolvers — an erased pet resolves null (shape B)", () => {
  // The EIGHT token→pet resolvers below (count the tests, not this prose —
  // an earlier version said "six" over these same eight): each is fronted by
  // a caller-scoped custody predicate, so reaching one takes the org that
  // legitimately held the animal — lower exposure than the writers above,
  // same class. All of them now resolve through `unerasedPetByToken` — the
  // authenticated ALIAS of publicPetByToken (ONE guarded predicate, not
  // eight hand-rolled filters; the alias exists so the throttle census does
  // not flag these authenticated files as anonymous resolvers).
  // Each pair below is one resolver's own mutation tripwire: revert its call
  // site and exactly that pair goes red — the live half is the per-resolver
  // non-vacuity floor.

  it("FosterRepository.findShelterPetByToken drops the erased pet, keeps the live one", async () => {
    expect(await FosterRepository.findShelterPetByToken(TOKEN_ERASED, sponsorOrgId)).toBeNull();
    const live = await FosterRepository.findShelterPetByToken(TOKEN_MOVED, sponsorOrgId);
    expect(live?.id).toBe(movedPetId);
  });

  it("FosterRepository.findPetByToken drops the erased pet, keeps the live one", async () => {
    expect(await FosterRepository.findPetByToken(TOKEN_ERASED)).toBeNull();
    expect((await FosterRepository.findPetByToken(TOKEN_MOVED))?.id).toBe(movedPetId);
  });

  it("TransfersRepository.findPetByToken drops the erased pet, keeps the live one", async () => {
    expect(await TransfersRepository.findPetByToken(TOKEN_ERASED)).toBeNull();
    expect((await TransfersRepository.findPetByToken(TOKEN_MOVED))?.id).toBe(movedPetId);
  });

  it("TransfersRepository.findPetUnderOrg drops the erased pet, keeps the live one", async () => {
    expect(await TransfersRepository.findPetUnderOrg(TOKEN_ERASED, sponsorOrgId)).toBeNull();
    const live = await TransfersRepository.findPetUnderOrg(TOKEN_MOVED, sponsorOrgId);
    expect(live?.pet.id).toBe(movedPetId);
  });

  it("AdoptionRepository.findShelterPet drops the erased pet, keeps the live one", async () => {
    expect(await AdoptionRepository.findShelterPet(TOKEN_ERASED, sponsorOrgId)).toBeNull();
    const live = await AdoptionRepository.findShelterPet(TOKEN_MOVED, sponsorOrgId);
    expect(live?.id).toBe(movedPetId);
  });

  it("AdoptionRepository.findPetForApplication drops the erased pet, keeps the live one", async () => {
    expect(await AdoptionRepository.findPetForApplication(TOKEN_ERASED)).toBeNull();
    const live = await AdoptionRepository.findPetForApplication(TOKEN_MOVED);
    expect(live?.pet.id).toBe(movedPetId);
  });

  it("AdoptionRepository.findPetByToken drops the erased pet, keeps the live one", async () => {
    expect(await AdoptionRepository.findPetByToken(TOKEN_ERASED)).toBeNull();
    expect((await AdoptionRepository.findPetByToken(TOKEN_MOVED))?.id).toBe(movedPetId);
  });

  it("RehomeRepository.findPetByToken drops the erased pet, keeps the live one", async () => {
    expect(await RehomeRepository.findPetByToken(TOKEN_ERASED)).toBeNull();
    expect((await RehomeRepository.findPetByToken(TOKEN_MOVED))?.id).toBe(movedPetId);
  });
});

describe("secondary identifiers — an erased pet's chip and tattoo read as never registered", () => {
  // Range-5 family (the one every previous sweep missed, because every sweep
  // searched for TOKEN resolution): pet_identifications rows stay `active`
  // after the erasure, so without a filter inside the lookups the chip
  // answered with the pet's name, token, status and the owner's first name —
  // across the alta cross-checks, the claim wizard, the denuncia form, org
  // intake and the CSV import, every one of them distinguishable from "never
  // existed". The filter lives in the two lookup helpers (and in the claim
  // wizard's own tattoo query), so each test below is that filter's mutation
  // tripwire; the live pet in each is the non-vacuity floor.

  it("lookupByChip resolves nothing for the erased pet's chip, still resolves the moved pet's", async () => {
    expect(await lookupByChip(CHIP_ERASED)).toBeNull();
    const live = await lookupByChip(CHIP_MOVED);
    expect(live?.pet.id).toBe(movedPetId);
  });

  it("lookupByTattoo resolves nothing for the erased pet's tattoo, still resolves the moved pet's", async () => {
    expect(await lookupByTattoo(TATTOO_ERASED)).toBeNull();
    const live = await lookupByTattoo(TATTOO_MOVED);
    expect(live?.pet.id).toBe(movedPetId);
  });

  it("claim lookup answers not_found for the erased pet's chip — not a named card", async () => {
    // Before the filter this returned `active_owner` with the pet's NAME: the
    // erased subject's ownership row is still live (the RPC never touches
    // ownerships), so every variant of the wizard named the erased pet.
    expect(
      await lookupForClaimForUser(keeperUserId, { kind: "microchip", value: CHIP_ERASED }),
    ).toEqual({ variant: "not_found" });
    const live = await lookupForClaimForUser(keeperUserId, {
      kind: "microchip",
      value: CHIP_MOVED,
    });
    expect("variant" in live && live.variant).toBe("active_owner");
  });

  it("claim lookup answers not_found for the erased pet's tattoo — its own query, its own filter", async () => {
    expect(
      await lookupForClaimForUser(keeperUserId, { kind: "tattoo", value: TATTOO_ERASED }),
    ).toEqual({ variant: "not_found" });
    const live = await lookupForClaimForUser(keeperUserId, { kind: "tattoo", value: TATTOO_MOVED });
    expect("variant" in live && live.variant).toBe("active_owner");
  });
});

describe("org queue projections — pinned the day the 'not invocable from vitest' claim fell", () => {
  // countActiveFosters / signalActiveAdoptions / fetchRequiresAction carry
  // their art. 16 filters since the thirteen-surfaces unit, but were left
  // unpinned behind the same false claim as the vecino writer. They are
  // reachable through exported functions like everything else here; the
  // honest cost was FIXTURES, paid above (foster rows, an aged application,
  // overdue vaccinations). fetchTodayAgenda and countOverdueCheckins stay
  // unpinned — their fixture worlds (appointments stack; a second pet pair
  // with adoption_finalized, which would zero fetchActiveAdoptions here) are
  // not paid in this file, and the registry says so.

  it("countActiveFosters (via fetchOrgQueueCounts) counts only the live pet's foster", async () => {
    const counts = await fetchOrgQueueCounts(sponsorOrgId, ["activeFosters"]);
    expect(counts.activeFosters).toBe(1);
  });

  it("signalActiveAdoptions (via fetchOrgQueueSignals) ages only the live application", async () => {
    const signals = await fetchOrgQueueSignals(sponsorOrgId, ["activeAdoptions"]);
    // The erased pet's application is 10 days old; the live one is from today.
    // <= 1 (not 0) so an AR-midnight boundary between fixture and assertion
    // cannot flake this — still an order of magnitude away from the 10 the
    // reverted filter reports.
    expect(signals.activeAdoptions?.oldestAgeDays).toBeLessThanOrEqual(1);
  });

  it("fetchRequiresAction flags only the live pet's overdue vaccine", async () => {
    const items = await fetchRequiresAction(sponsorOrgId);
    const ids = items.map((i) => i.petId);
    expect(ids).toContain(movedPetId);
    expect(ids).not.toContain(erasedPetId);
  });
});

describe("erase releases the microchip so a finder can re-register (reunification unit)", () => {
  // The chip release is APPLICATION-layer (erase-subject-data.ts Step 1.5,
  // outside the RPC), so it is invoked here against the same post-erasure
  // fixtures the RPC produced in beforeAll: the erased pet is soft-deleted with
  // its owner row still live and carries an active chip + a microchip_implanted
  // event; the moved pet is the non-erased control. Every assertion below is the
  // decided unit — a RELEASED (not deleted, not bare-flipped) reunification
  // identifier that a finder can re-register.
  beforeAll(async () => {
    await releaseMicrochipsForErasedPets(erasedUserId);
  });

  it("flips the erased pet's canonical chip row out of 'active' (released, not deleted)", async () => {
    const [row] = await db
      .select({ status: petIdentifications.status })
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, erasedPetId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.code, CHIP_ERASED),
        ),
      );
    // The row still EXISTS (append-only history is not destroyed) — it just left
    // the partial unique index by ceasing to be 'active'.
    expect(row).toBeDefined();
    expect(row.status).not.toBe("active");
  });

  it("emits a microchip_replaced revocation event (new_chip_number = null)", async () => {
    const events = await db
      .select({ id: petEvents.id, payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, erasedPetId), eq(petEvents.eventType, "microchip_replaced")));
    const revocation = events.find(
      (e) => (e.payload as Record<string, unknown>).new_chip_number === null,
    );
    expect(
      revocation,
      "a pure-revocation microchip_replaced event on the erased pet",
    ).toBeDefined();
  });

  it("keeps the stored canonical row and the event replay in agreement (no drift)", async () => {
    // The whole reason the release is event-backed. detect-pet-cache-drift
    // replays events for ALL pets (no deleted_at filter) and compares to the
    // stored row. A bare status flip with no retraction event would leave the
    // replay seeing the implant's active chip forever → false-positive drift on
    // every erased pet. With the revocation event, BOTH say "no active chip".
    const events = await db
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        recordedAt: petEvents.recordedAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(eq(petEvents.petId, erasedPetId))
      .orderBy(petEvents.occurredAt);
    // Derived (event replay): no active chip.
    expect(replayPetMicrochip(events).microchipId).toBeNull();
    // Stored (canonical): no active chip row either.
    const activeRows = await db
      .select({ id: petIdentifications.id })
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.petId, erasedPetId),
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.status, "active"),
        ),
      );
    expect(activeRows).toHaveLength(0);
  });

  it("never touches a non-erased pet's active chip", async () => {
    // The overreach guard, mirroring the pet-soft-delete asymmetry above: the
    // moved pet was never erased, so its chip stays active and no revocation
    // event is written on its spine.
    const [row] = await db
      .select({ status: petIdentifications.status })
      .from(petIdentifications)
      .where(
        and(eq(petIdentifications.petId, movedPetId), eq(petIdentifications.code, CHIP_MOVED)),
      );
    expect(row.status).toBe("active");
    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, movedPetId), eq(petEvents.eventType, "microchip_replaced")));
    expect(events).toHaveLength(0);
  });

  it("frees the released code — re-registering it now succeeds (no 23505)", async () => {
    // Before the release CHIP_ERASED was an active row and this exact insert
    // violated pet_identifications_chip_unique. Now the erased pet's row is
    // 'replaced' — outside the partial index — so whoever now holds the animal
    // can register it. This is the finder's re-registration, reduced to its
    // load-bearing statement.
    const reclaimerPetId = await insertPet(TOKEN_RECLAIM, "PO4 Reclaimer");
    try {
      await expect(
        db.insert(petIdentifications).values({
          petId: reclaimerPetId,
          kind: "microchip_iso",
          code: CHIP_ERASED,
          status: "active",
        }),
      ).resolves.toBeDefined();
    } finally {
      // pet_identifications.pet_id is ON DELETE CASCADE, so this removes the
      // reclaim row with the pet. No events on it, so no override needed.
      await db.delete(pets).where(eq(pets.id, reclaimerPetId));
    }
  });

  it("is idempotent — a second release emits no further event", async () => {
    // Re-running the erasure (or this step) must be a no-op: the active row is
    // already 'replaced', so the scan finds no active chip and nothing is
    // emitted. This is what makes the step safe to retry after a partial failure.
    const before = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, erasedPetId), eq(petEvents.eventType, "microchip_replaced")));
    await releaseMicrochipsForErasedPets(erasedUserId);
    const after = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, erasedPetId), eq(petEvents.eventType, "microchip_replaced")));
    expect(after.length).toBe(before.length);
  });
});

describe("admin microchip door — an erased pet reads as never-existed (token-addressed write)", () => {
  // The WRITE half of the state-operator token door (see the sweep at the bottom
  // of this file for the whole map). `replaceMicrochipAdminAction` is reachable
  // with a pet token and an admin session and NOTHING else: no welfare report,
  // no case, no observation mediates it. Before the art. 16 term it resolved the
  // erased pet and refused one gate later, with the WRONG sentence — "Esta
  // mascota no tiene microchip registrado.", produced by the chip release the
  // erasure itself performs. That is a refusal borrowed from another invariant:
  // it tells the caller the pet EXISTS and merely lacks a chip. Art. 16 says
  // deleted must be indistinguishable from never-existed, so the refusal has to
  // come from resolution.
  //
  // The page twin (`.../reemplazar/page.tsx`) got the same term in the same
  // change but is a server component with no plain-argument entry point; it is
  // pinned STATICALLY only, by the sweep below. Said, not hidden.
  const importAction = async () =>
    (await import("@/app/admin/observaciones/[publicToken]/microchip/reemplazar/action"))
      .replaceMicrochipAdminAction;

  it("refuses the erased pet with the never-existed copy", async () => {
    const replaceMicrochipAdminAction = await importAction();
    const result = await replaceMicrochipAdminAction(TOKEN_ERASED, { error: null }, new FormData());
    expect(result).toEqual({ error: "Mascota no encontrada." });
  });

  it("non-vacuity: the live pet passes resolution and fails on the NEXT gate instead", async () => {
    // The moved pet was never erased and still carries CHIP_MOVED as its active
    // canonical chip (pinned by the reunification unit above), so it clears BOTH
    // resolution and the has-a-chip gate and dies on reason validation. That is
    // what makes the assertion above about the FILTER and not about the action
    // refusing everything.
    const replaceMicrochipAdminAction = await importAction();
    const result = await replaceMicrochipAdminAction(TOKEN_MOVED, { error: null }, new FormData());
    expect(result).toEqual({ error: "Motivo inválido." });
  });
});

// ---------------------------------------------------------------------------
// Static sweep — A RULE, NOT A LIST.
//
// WHY THIS WAS REWRITTEN. The first version of this sweep walked a FIXED array
// of nine route files and asserted each resolved through `publicPetByToken`.
// It was green the whole time `/perdidas` and `app/sitemap.ts` were publishing
// an erased subject's pet — name, breed, colour, "Localidad, Provincia" and
// "hace N días" — and the sitemap was handing `/p/{token}` to Google every day
// at priority 0,85, where it 404s. That is the difference the erasure policy
// (PO-4) says must not be observable: "deleted" became distinguishable from
// "never existed".
//
// A hand-kept list cannot catch that, because the failure mode IS forgetting.
// The list did not fail — it was never told. So the sweep now DERIVES the set
// it checks:
//
//   1. Take every Next entry file (page/route/layout/…) under the route groups
//      that serve requests WITHOUT a session.
//   2. Walk the import graph forward from them.
//   3. Subtract the closure of every OTHER entry file. What is left is
//      PUBLIC-ONLY code: modules that exist to answer unauthenticated callers
//      and nobody else. A module shared with `/gob` or `/mis-mascotas` is not
//      in scope — it answers an authorized caller too, and its filtering is
//      that caller's question, not this one's.
//   4. In each of those files, every read of `pets` must carry the soft-delete
//      guard.
//
// WHAT THIS RULE STILL CANNOT SEE — stated, not left to be rediscovered:
//
//   • THE SEED IS DECLARED. `UNAUTHENTICATED_ENTRIES` below names route groups,
//     not files. Nothing in the tree marks a route "unauthenticated", so a NEW
//     unauthenticated route GROUP must be added here by hand. That is a rare and
//     visible event (four exist today, and adding one is a routing decision);
//     adding a page or a query under an existing one is constant, and THAT is
//     what the old list kept missing. Coarser seed, mechanical body.
//   • IT COUNTS, IT DOES NOT PARSE. The check compares "reads of `pets`" against
//     "soft-delete guards" per file. A file with two reads and two guards on the
//     same read passes. Statement-level segmentation was tried and rejected
//     against this corpus: `lost-listing-read.ts` and `adoption-listing-read.ts`
//     both build a predicate ARRAY dozens of lines above the `.where()` that
//     consumes it, so no window around the query contains its own guard.
//   • DYNAMIC REACHABILITY. `directDeps` reads static import specifiers. A
//     module reached only through a computed `import()` is invisible.
//   • RLS IS THE OTHER HALF. This is a static check over application queries;
//     it says nothing about what a direct PostgREST client can read.
//
// The allowlist below is DEBT, not exemption. It may only shrink: an entry that
// stops violating fails this suite, so a fix cannot leave a stale line behind.
// ---------------------------------------------------------------------------

/** Route groups and files that answer a request with no session. */
const UNAUTHENTICATED_ENTRY_PREFIXES = [
  "app/(public)/", // the Next route group whose whole purpose is ungated pages
  "app/api/v1/", // the credential API — "the same door as the page" (review #7)
  "app/libreta/", // /libreta/compartir/{shareToken} — a share link, no session
  "app/r/", // /r/invite/{token} — an invitation opened before signing in
] as const;
const UNAUTHENTICATED_ENTRY_FILES = [
  "app/page.tsx", // the landing page
  "app/sitemap.ts", // hands URLs to search engines; the one that advertised 404s
  "app/robots.ts", // present or not, it is an unauthenticated surface
] as const;

/** Next's own entry-file names. Everything else is an imported module. */
const NEXT_ENTRY_FILE =
  /^(page|route|layout|default|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|error|not-found|loading)\.tsx?$/;

/**
 * A read of the `pets` table, in BOTH shapes this repo uses:
 *   • the Drizzle query builder — the FROM side or any join onto it
 *     (`.from(pets`, `.leftJoin(pets`, …); and
 *   • raw SQL inside a `sql`…`` template — `FROM pets` / `JOIN pets`, which is
 *     plain text the builder pattern above cannot see. postulaciones and the
 *     org adopciones queue resolve `pets` this way (`db.execute(sql`… JOIN pets
 *     p …`)`); a bare token join there leaked an erased pet until this branch
 *     was added. The raw branch requires whitespace after from/join, so the
 *     builder's `from(pets`/`Join(pets` never double-counts here.
 */
const PETS_READ =
  /\.(?:from|leftJoin|innerJoin|rightJoin|fullJoin)\(\s*pets\b|\b(?:from|join)\s+pets\b/gi;
/** The soft-delete guard, in every spelling this repo actually uses.
 * `unerasedPetByToken` is the authenticated ALIAS of publicPetByToken — the
 * SAME predicate object, so it filters identically and counts as a guard here.
 * (Whether a file is ALLOWED to spell the alias is the throttle census's
 * question — public-token-throttle-coverage.test.ts pins that set.)
 * `deleted_at IS NULL` is the RAW-SQL spelling — the term a `sql`…`` template
 * carries (`AND p.deleted_at IS NULL`, and `${pets.deletedAt} IS NULL` whose
 * `pets.deletedAt` half is matched directly). It is the guard that pairs with
 * the raw-SQL read branch of PETS_READ above; postulaciones and the org
 * adopciones queue both spell it. */
const SOFT_DELETE_GUARD =
  /(pets\.deletedAt|pets\.deleted_at|publicPetByToken|unerasedPetByToken|deleted_at\s+IS\s+NULL)/gi;

/**
 * KNOWN DEBT — public-only files that read `pets` without the guard.
 *
 * Each line is a real instance of the same class the erasure policy forbids,
 * left out of this change because it is not its subject. The rule is what makes
 * them visible at all: the old fixed list never mentioned a single one.
 */
const SOFT_DELETE_DEBT = new Map<string, string>([
  [
    "app/page.tsx",
    "Landing demo-pet existence probe. Leaks only whether the DECLARED demo token resolves, and the token is a deployment constant.",
  ],
  [
    "lib/infra/caretaker-public-contact.ts",
    "Joins pets to decide the lost-mode caretaker disclosure. Its caller resolves the pet through the guard first, so it is reachable only for a live pet today — an assumption nothing enforces.",
  ],
]);

function publicOnlyModules(): string[] {
  const appDir = resolve(ROOT, "app");
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name).replace(/\\/g, "/");
      if (e.isDirectory()) walk(full);
      else if (NEXT_ENTRY_FILE.test(e.name)) entries.push(full);
    }
  };
  walk(appDir);

  const relOf = (f: string): string => f.slice(`${ROOT}/`.length);
  const isUnauthenticated = (f: string): boolean => {
    const rel = relOf(f);
    return (
      UNAUTHENTICATED_ENTRY_PREFIXES.some((p) => rel.startsWith(p)) ||
      (UNAUTHENTICATED_ENTRY_FILES as readonly string[]).includes(rel)
    );
  };

  const closure = (roots: string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const dep of directDeps(file)) if (!seen.has(dep)) queue.push(dep);
    }
    return seen;
  };

  const openDoor = closure(entries.filter(isUnauthenticated));
  const behindAuth = closure(entries.filter((f) => !isUnauthenticated(f)));
  return [...openDoor]
    .filter((f) => !behindAuth.has(f) && /\.tsx?$/.test(f))
    .map(relOf)
    .sort();
}

/** Comments are not code: a guard quoted in prose must not count as one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

/**
 * Imports are declarations, not filters: naming `publicPetByToken` at the top
 * of a file guards nothing. Matches the whole statement (single- or multi-line,
 * `import type` included) so a helper listed on its own line inside a braced
 * import cannot survive the strip. Dynamic `import(` has no space after the
 * keyword, so it is deliberately left alone — that IS a call.
 */
const IMPORT_STATEMENT = /(?:^|\n)\s*import\s[\s\S]*?\sfrom\s*["'][^"']*["']\s*;?/g;
function stripImports(source: string): string {
  return source.replace(IMPORT_STATEMENT, "\n");
}

type PetsReader = { rel: string; reads: number; guards: number };

/** Counts reads of `pets` and soft-delete guards in one module's source. */
function countPetsAccess(rawSource: string): { reads: number; guards: number } {
  const source = stripImports(stripComments(rawSource));
  return {
    reads: source.match(PETS_READ)?.length ?? 0,
    guards: source.match(SOFT_DELETE_GUARD)?.length ?? 0,
  };
}

function scanPublicOnlyPetsReaders(): PetsReader[] {
  const out: PetsReader[] = [];
  for (const rel of publicOnlyModules()) {
    let raw: string;
    try {
      raw = readFileSync(resolve(ROOT, rel), "utf8");
    } catch {
      continue;
    }
    const { reads, guards } = countPetsAccess(raw);
    if (reads === 0) continue;
    out.push({ rel, reads, guards });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The counter itself, before it is trusted over the whole app tree.
//
// WHY (fresh-context review, 2026-08-22): SOFT_DELETE_GUARD matches the bare
// identifier `publicPetByToken`, so the IMPORT STATEMENT counted as a guard.
// Measured on app/(public)/p/[publicToken]/page.tsx: reads=1 guards=2 — line 37
// is `import { publicPetByToken } …`, line 137 the only actual use. The file had
// exactly one guarded read and a spare guard in hand, so a SECOND, unguarded
// `.from(pets)` added to it still satisfied `guards >= reads` and the rule
// stayed green. An import is a declaration, not a filter; it must not count.
// ---------------------------------------------------------------------------
describe("the guard counter does not mistake declarations for filters", () => {
  it("an import of the guard helper does not pay for an unguarded read", () => {
    const source = [
      'import { publicPetByToken } from "@/lib/infra/public-pet-lookup";',
      "",
      "const live = await db.select().from(pets).where(publicPetByToken(token));",
      "const leaky = await db.select().from(pets).where(eq(pets.publicToken, token));",
    ].join("\n");

    // Two reads, but only ONE of them is actually guarded.
    expect(countPetsAccess(source).reads).toBe(2);
    expect(countPetsAccess(source).guards).toBe(1);
  });

  it("a multi-line import of the guard helper does not count either", () => {
    const source = [
      "import {",
      "  publicPetByToken,",
      "  somethingElse,",
      '} from "@/lib/infra/public-pet-lookup";',
      "",
      "const leaky = await db.select().from(pets).where(eq(pets.publicToken, token));",
    ].join("\n");

    expect(countPetsAccess(source).reads).toBe(1);
    expect(countPetsAccess(source).guards).toBe(0);
  });

  it("a real guard next to a real read still counts", () => {
    const source = [
      'import { publicPetByToken } from "@/lib/infra/public-pet-lookup";',
      "",
      "const live = await db.select().from(pets).where(publicPetByToken(token));",
    ].join("\n");

    const { reads, guards } = countPetsAccess(source);
    expect(reads).toBe(1);
    expect(guards).toBe(1);
    expect(guards).toBeGreaterThanOrEqual(reads);
  });

  it("a type-only import is a declaration too", () => {
    const source = [
      'import type { PublicPetByToken } from "@/lib/infra/public-pet-lookup";',
      'import { publicPetByToken } from "@/lib/infra/public-pet-lookup";',
      "",
      "const leaky = await db.select().from(pets).where(eq(pets.publicToken, token));",
    ].join("\n");

    expect(countPetsAccess(source).guards).toBe(0);
  });

  it("sees a raw-SQL `JOIN pets` read, and its `deleted_at IS NULL` guard", () => {
    // The blind spot postulaciones fell into: a pets read spelled in raw SQL
    // inside a sql`…` template, which the Drizzle-builder pattern never matched.
    // Unguarded → one read, zero guards (the leak). Guarded with the raw-SQL
    // spelling → one read, one guard (the fix). Both halves proven here so the
    // regex change is pinned independently of the DB-backed sweep below.
    const leaky = [
      "const rows = await db.execute(sql`",
      "  SELECT p.name FROM my_submissions s",
      "  JOIN pets p ON p.id = s.pet_id",
      "`);",
    ].join("\n");
    expect(countPetsAccess(leaky).reads).toBe(1);
    expect(countPetsAccess(leaky).guards).toBe(0);

    const guarded = [
      "const rows = await db.execute(sql`",
      "  SELECT p.name FROM my_submissions s",
      "  JOIN pets p ON p.id = s.pet_id",
      "    AND p.deleted_at IS NULL",
      "`);",
    ].join("\n");
    expect(countPetsAccess(guarded).reads).toBe(1);
    expect(countPetsAccess(guarded).guards).toBe(1);

    // A raw JOIN onto pet_events must NOT be mistaken for a pets read.
    const eventsOnly = "FROM pet_events e JOIN pet_events d ON d.pet_id = e.pet_id";
    expect(countPetsAccess(eventsOnly).reads).toBe(0);
  });
});

describe("every unauthenticated read of `pets` carries the soft-delete filter (PO-4 rule)", () => {
  const readers = scanPublicOnlyPetsReaders();
  const violations = readers.filter((r) => r.guards < r.reads).map((r) => r.rel);

  // NON-VACUITY FLOOR, three ways. A rule whose graph walk quietly returns
  // nothing is greener than a correct one, and that is the exact shape of the
  // defect this replaces.
  it("actually reaches the public surfaces it claims to check", () => {
    const rels = readers.map((r) => r.rel);
    expect(readers.length).toBeGreaterThanOrEqual(12);
    // Named anchors: the two listings this rule was written for, the credential
    // page, and the API — the second door onto the same data.
    expect(rels).toContain("src/modules/lost/infrastructure/lost-listing-read.ts");
    expect(rels).toContain("src/modules/adoption/infrastructure/adoption-listing-read.ts");
    // The credential's own pet read moved out of page.tsx on 2026-09-23 — its
    // `generateMetadata` query was replaced by the memoised, throttled probe
    // the landing layout's 404 gate shares — so the anchor follows the read.
    // It followed it once more the same day: the probe and the door had two
    // copies of the pet-row query, now ONE (`selectPublicCredentialPetRow`, in
    // the door module), so the `pets` read the census sees lives there.
    expect(rels).toContain("src/modules/pets/application/read/lookup-public-credential.ts");
    // And it must NOT have swallowed the authenticated half: the govt/admin
    // aggregates read `pets` unguarded by design and are not this rule's
    // business. Seeing one here means the subtraction stopped working.
    expect(rels).not.toContain("lib/metrics/census.ts");
    expect(rels).not.toContain("src/modules/panorama/infrastructure/repository-history.ts");
  });

  it("flags an unguarded read and clears a guarded one", () => {
    // The detector against hand-written samples, so a regex that stopped
    // matching anything cannot pass by finding zero violations everywhere.
    const bad = "const rows = await db.select().from(pets).where(eq(pets.status, 'lost'));";
    const good =
      "const rows = await db.select().from(pets).where(and(eq(pets.status, 'lost'), isNull(pets.deletedAt)));";
    const commented = "// isNull(pets.deletedAt) used to be here\nawait db.select().from(pets);";
    const count = (s: string, re: RegExp) => stripComments(s).match(re)?.length ?? 0;
    expect(count(bad, PETS_READ)).toBe(1);
    expect(count(bad, SOFT_DELETE_GUARD)).toBe(0);
    expect(count(good, SOFT_DELETE_GUARD)).toBe(1);
    // A guard that lives in a comment is prose, not a filter.
    expect(count(commented, SOFT_DELETE_GUARD)).toBe(0);
  });

  it("has no unguarded read outside the declared debt", () => {
    expect(violations.filter((rel) => !SOFT_DELETE_DEBT.has(rel))).toEqual([]);
  });

  it("carries no stale debt — the allowlist may only shrink", () => {
    expect([...SOFT_DELETE_DEBT.keys()].filter((rel) => !violations.includes(rel))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ORG PORTAL SWEEP (range-5 unit, 2026-08-28). The public rule above cannot
// see app/org — those pages answer authenticated org members — but the org
// portal turned out to be where the erasure leaked longest: `ownerships`
// survives the RPC by design, so every org join that reaches `pets` through a
// custody row, an event, a case or an appointment still surfaced the erased
// pet's NAME. Seven screens carried zero guards when this sweep was seeded
// (agenda + turno detail, intake queue, maltrato ×2 reads, transferencias
// salientes + recibidas ×2, voluntarios/propuestas) — the previous unit
// declined to seed precisely because its measurement predated those fixes and
// forecast a 12-entry exception list. Post-fix the list is TWO pinned
// guard-at-origin shapes, both structural, neither debt.
//
// Same counting rule as the public sweep (`guards >= reads`, comments and
// imports stripped), same stated blind spots — plus one of its own: a file
// whose reads are all scoped by petIds resolved in ANOTHER file would flag
// here even though its origin guard is real. None exists under app/org today;
// if one appears, it gets a pin with the origin named, like the two below.
// ---------------------------------------------------------------------------

type OrgOriginPin = { reads: number; guards: number; origin: string };

/**
 * GUARD-AT-ORIGIN pins — files where ONE textual guard covers SEVERAL reads
 * by construction. Counts are pinned EXACTLY: adding a read (or a guard) to a
 * pinned file changes its shape and fails this sweep until a human re-reviews
 * the file and re-pins it. That is the point — these two shapes were verified
 * by reading the code, and the pin must not outlive what was read.
 */
const ORG_GUARD_AT_ORIGIN: Record<string, OrgOriginPin> = {
  "app/org/[orgToken]/checkins/page.tsx": {
    reads: 3,
    guards: 1,
    origin:
      "The adopted-pet id list is bounded by isNull(pets.deletedAt) at its source query; the two list reads below it filter by inArray(petIds) and cannot reach a pet the source dropped.",
  },
  "app/org/[orgToken]/mascotas/page.tsx": {
    reads: 2,
    guards: 1,
    origin:
      "One whereConditions array carries the guard and feeds BOTH reads (the list and its count) — two queries, one predicate.",
  },
};

function scanOrgPetsReaders(): PetsReader[] {
  const orgDir = resolve(ROOT, "app", "org");
  const out: PetsReader[] = [];
  for (const entry of readdirSync(orgDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    const full = join(entry.parentPath, entry.name);
    const { reads, guards } = countPetsAccess(readFileSync(full, "utf8"));
    if (reads === 0) continue;
    out.push({ rel: full.slice(`${ROOT}`.length + 1).replaceAll("\\", "/"), reads, guards });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

describe("every org-portal read of `pets` carries the soft-delete filter (art. 16)", () => {
  const readers = scanOrgPetsReaders();
  const violations = readers.filter((r) => r.guards < r.reads);

  it("actually reaches the org surfaces it claims to check", () => {
    const rels = readers.map((r) => r.rel);
    expect(readers.length).toBeGreaterThanOrEqual(20);
    // Named anchors: the screens this sweep was seeded FOR.
    expect(rels).toContain("app/org/[orgToken]/agenda/page.tsx");
    expect(rels).toContain("app/org/[orgToken]/maltrato/recibidos/page.tsx");
    expect(rels).toContain("app/org/[orgToken]/mascotas/page.tsx");
  });

  it("has no under-guarded file outside the pinned guard-at-origin shapes", () => {
    const unexplained = violations.filter((r) => {
      const pin = ORG_GUARD_AT_ORIGIN[r.rel];
      return !pin || pin.reads !== r.reads || pin.guards !== r.guards;
    });
    expect(unexplained).toEqual([]);
  });

  it("carries no stale or drifted pin — a pin describes exactly what was reviewed", () => {
    for (const [rel, pin] of Object.entries(ORG_GUARD_AT_ORIGIN)) {
      const reader = readers.find((r) => r.rel === rel);
      expect(reader, `${rel} no longer reads pets — delete its pin`).toBeDefined();
      expect(
        { reads: reader?.reads, guards: reader?.guards },
        `${rel} changed shape — re-review the file and re-pin`,
      ).toEqual({ reads: pin.reads, guards: pin.guards });
      // A pin is only for the under-guarded shape; a fully guarded file needs none.
      expect(pin.guards).toBeLessThan(pin.reads);
    }
  });
});

// ---------------------------------------------------------------------------
// CITIZEN APP-TREE SWEEP (ninth art. 16 family, 2026-08-28; WIDENED the same day
// to the WHOLE app/(app) tree — the "tenth form"). Neither sweep above can see
// app/(app): the public rule stops at unauthenticated reachability, and the org
// sweep scans only app/org. But the citizen side has the SAME structural leak
// the org portal had — the erasure RPC soft-deletes only role='owner' pets and
// ends only role='caretaker' rows, so a role='foster' (or co_owner) ownership
// survives with ended_at = NULL, and bookSlotAction accepts ANY active ownership
// role, so a non-owner booker holds an appointment whose ownerUserId is their
// own id. Through such a surviving row a THIRD PARTY (the foster, the non-owner
// booker, an adoption applicant, a welfare reporter) kept seeing the erased
// pet's NAME and a working link.
//
// THIS SWEEP NOW WALKS THE ENTIRE app/(app) TREE, IN BOTH READ SHAPES. Its
// FIRST version scoped only cuenta/transitos + mis-turnos and said so in a
// SCOPE note that flagged the rest of app/(app) as un-audited debt. A follow-up
// measurement found ~8 more under-guarded readers under app/(app) —
// cuenta/chapas, denuncias/[id], three mis-mascotas subpages that resolve
// access INLINE (asistencia, buscar-hogar, devolucion) rather than through
// resolvePetHolderAccess, the IntentApplyBanner (a shelter_custody adoption
// listing that survives a rehome-R4 titular's erasure), and both turnos/buscar
// readers (the booking pet picker + the jurisdiction prefill). All were
// filtered in the same change; the old scope note is gone because the scope is
// now the whole tree.
//
// But "the whole tree" was a HALF-TRUTH until PETS_READ learned raw SQL. The
// counter matched only the Drizzle builder (`.from/join(pets`), so a pets read
// spelled `db.execute(sql`… JOIN pets p …`)` scored reads=0 and the file was
// SKIPPED — invisible, not guarded. mis-mascotas/postulaciones/page.tsx was
// exactly that: the ONLY raw-SQL pets reader under app/(app), a `JOIN pets p`
// that fed an erased pet's name and a live /adoptar link to a third-party
// adoption applicant (same rehome-R4 reachability as IntentApplyBanner). The
// same-day widening claimed whole-tree coverage while this reader leaked. The
// fix has two halves, both landed here: postulaciones now carries
// `AND p.deleted_at IS NULL`, and PETS_READ's raw-SQL branch (plus the guard
// regex's `deleted_at IS NULL` spelling) makes that reader — and every future
// raw-SQL one — VISIBLE and checkable. (The org adopciones queue reads `pets`
// the same raw way and was already guarded; the org sweep now sees it too.)
//
// Same counting rule as the sweeps above (`guards >= reads`, comments and
// imports stripped), same stated blind spots. Post-fix the exception list is
// EMPTY — every direct `pets` read under app/(app), Drizzle OR raw SQL, is
// DIRECTLY guarded, so any new under-guarded read here fails immediately.
//
// WHAT THIS SWEEP DOES NOT SEE, and why it needs no pins today: the many
// mis-mascotas subpages that gate on resolvePetHolderAccess (lib/infra/
// pet-access.ts, which already filters isNull(pets.deletedAt) on BOTH of its
// paths) do NO direct `.from/join(pets)` of their own, so they never enter this
// scan — their guard-at-origin is real but invisible here by construction, not
// by exemption. If a genuine guard-at-origin shape ever appears IN this scan
// (a file whose reads are all scoped by a petIds list bounded in ANOTHER file),
// it gets a pin naming the origin, exactly like ORG_GUARD_AT_ORIGIN — never a
// cosmetic filter to quiet this sweep.
// ---------------------------------------------------------------------------

type CitizenOriginPin = { reads: number; guards: number; origin: string };

/**
 * GUARD-AT-ORIGIN pins for app/(app). EMPTY by construction today: every direct
 * `pets` read under app/(app) carries its own soft-delete term, and the subpages
 * bounded upstream by resolvePetHolderAccess do no direct read so never reach
 * this scan. A file whose reads are all scoped by a petIds list resolved
 * elsewhere would flag here even with a real origin guard — that file gets a pin
 * with the origin named, exactly like ORG_GUARD_AT_ORIGIN. None exists today.
 */
const APP_GUARD_AT_ORIGIN: Record<string, CitizenOriginPin> = {};

const APP_SWEEP_ROOT = join("app", "(app)");

function scanAppTreePetsReaders(): PetsReader[] {
  const out: PetsReader[] = [];
  const root = resolve(ROOT, APP_SWEEP_ROOT);
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.")) continue;
    const full = join(entry.parentPath, entry.name);
    const { reads, guards } = countPetsAccess(readFileSync(full, "utf8"));
    if (reads === 0) continue;
    out.push({ rel: full.slice(`${ROOT}`.length + 1).replaceAll("\\", "/"), reads, guards });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

describe("every app/(app) citizen read of `pets` carries the soft-delete filter (art. 16)", () => {
  const readers = scanAppTreePetsReaders();
  const violations = readers.filter((r) => r.guards < r.reads);

  it("actually reaches the citizen surfaces it claims to check", () => {
    const rels = readers.map((r) => r.rel);
    // 17 readers today (16 Drizzle + postulaciones once PETS_READ learned raw
    // SQL); a floor well below that stays non-vacuous while tolerating a page
    // being deleted, and still fails a graph walk that silently returns nothing.
    expect(readers.length).toBeGreaterThanOrEqual(15);
    // Named anchors: the six tránsito/turno screens the sweep was seeded for
    // and the eight readers the widening to the whole app/(app) tree pulled in.
    //
    // POSTULACIONES IS NO LONGER ONE OF THEM, and its absence is the reason the
    // describe block underneath exists. It was named here as "the one RAW-SQL
    // reader, invisible until PETS_READ learned to see `JOIN pets` inside a sql
    // template (the whole point of this unit)" — and on 2026-08-30 (WU-U) its
    // query moved out of the page into
    // `src/modules/adoption/infrastructure/my-applications-read.ts`, so that the
    // bearer door and the cookie door could not derive an application's status
    // two different ways.
    //
    // Deleting the anchor and stopping there would have quietly removed this
    // unit's only subject: NOTHING under app/(app) spells raw SQL over `pets`
    // any more (checked by hand, 2026-08-30), so the branch would still be code
    // with no test behind it. The anchor therefore FOLLOWS THE CODE rather than
    // being dropped — see "the raw-SQL reader that left app/(app)" below.
    expect(rels).toContain("app/(app)/cuenta/transitos/activos/page.tsx");
    expect(rels).toContain("app/(app)/cuenta/transitos/historial/page.tsx");
    expect(rels).toContain("app/(app)/cuenta/transitos/propuestas/page.tsx");
    expect(rels).toContain("app/(app)/cuenta/transitos/propuestas/[proposalToken]/page.tsx");
    expect(rels).toContain("app/(app)/mis-turnos/page.tsx");
    expect(rels).toContain("app/(app)/mis-turnos/[appointmentToken]/page.tsx");
    expect(rels).toContain("app/(app)/cuenta/chapas/page.tsx");
    expect(rels).toContain("app/(app)/denuncias/[id]/page.tsx");
    expect(rels).toContain("app/(app)/mis-mascotas/[publicToken]/asistencia/page.tsx");
    expect(rels).toContain("app/(app)/mis-mascotas/[publicToken]/buscar-hogar/page.tsx");
    expect(rels).toContain("app/(app)/mis-mascotas/[publicToken]/devolucion/page.tsx");
    expect(rels).toContain("app/(app)/mis-mascotas/_components/IntentApplyBanner.tsx");
    expect(rels).toContain("app/(app)/turnos/buscar/page.tsx");
    expect(rels).toContain("app/(app)/turnos/buscar/[offeringToken]/reservar/[slotId]/page.tsx");
  });

  it("has no under-guarded file outside the pinned guard-at-origin shapes", () => {
    const unexplained = violations.filter((r) => {
      const pin = APP_GUARD_AT_ORIGIN[r.rel];
      return !pin || pin.reads !== r.reads || pin.guards !== r.guards;
    });
    expect(unexplained).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The raw-SQL reader that left app/(app) (WU-U, 2026-08-30)
  // -------------------------------------------------------------------------
  // `readMyAdoptionApplications` is the query that used to sit inside
  // `app/(app)/mis-mascotas/postulaciones/page.tsx`. It is the reason PETS_READ
  // learned to match `JOIN pets` inside a `sql` template at all, and its guard
  // is the one that stops an ERASED pet's name rendering to a third-party
  // APPLICANT — the applicant's own submission row and the shelter's custody
  // row both survive a rehome-R4 titular's erasure, so nothing upstream filters
  // it for them.
  //
  // It now lives under src/, which no sweep in this file walks, and a module
  // that moved out of every sweep is a guard nothing checks. Pinned by PATH
  // rather than by a glob on purpose: this is one file with one guard and a
  // specific reason, and a glob would turn a precise claim into a vague one.
  it("keeps the guard on the raw-SQL applications reader after it moved to src/", () => {
    const rel = "src/modules/adoption/infrastructure/my-applications-read.ts";
    const source = readFileSync(resolve(ROOT, rel), "utf8");
    const { reads, guards } = countPetsAccess(source);
    // NON-VACUITY FIRST: a file that stopped reading `pets` (renamed, deleted,
    // rewritten onto a view) would satisfy `guards >= reads` at 0 and 0, which
    // reads exactly like a clean run.
    expect(reads, `${rel} no longer reads pets — this pin is describing nothing`).toBeGreaterThan(
      0,
    );
    expect(
      guards,
      `${rel} reads pets without the art. 16 guard — an erased pet's name would render to the applicant, who is a third party`,
    ).toBeGreaterThanOrEqual(reads);
  });

  it("carries no stale or drifted pin — a pin describes exactly what was reviewed", () => {
    for (const [rel, pin] of Object.entries(APP_GUARD_AT_ORIGIN)) {
      const reader = readers.find((r) => r.rel === rel);
      expect(reader, `${rel} no longer reads pets — delete its pin`).toBeDefined();
      expect(
        { reads: reader?.reads, guards: reader?.guards },
        `${rel} changed shape — re-review the file and re-pin`,
      ).toEqual({ reads: pin.reads, guards: pin.guards });
      expect(pin.guards).toBeLessThan(pin.reads);
    }
  });
});

// ---------------------------------------------------------------------------
// WRITE-SIDE + API SWEEP (eleventh art. 16 family, 2026-08-28). The three
// sweeps above scan RENDER surfaces — public reachability, app/org, app/(app)
// pages — so none of them looks at app/actions (Server Actions) or app/api
// (route handlers), the WRITE/mutation and second-door layer. That is exactly
// where the read-side booking fix left a twin hole: the reservar selector hid
// the erased pet (fixed in 36c9214b5), but `bookSlotAction` validated only
// `petStatus === 'deceased'`, never `pets.deleted_at`, and it accepts ANY
// active tenencia role — so a surviving foster/co-owner (the erasure ends
// neither) could hand-POST a booking onto an erased pet the read UI no longer
// offered. Fixing a read UI and not its write action leaves the mutation
// reachable directly; this sweep is the fence over that layer.
//
// SCOPE — and why it is honest. app/actions + app/api hold MANY pets readers
// that are legitimately owner/authenticated and NOT third-party-reachable, so a
// blanket `guards >= reads` here could have been noisy. It is not: the whole
// two-tree walk finds exactly FIVE direct `pets` readers today (measured, not
// asserted). Four are per-pet reads/writes reachable by a live third party —
// the ART.16 CLASS this fence exists for — and all four now carry the guard
// directly:
//   • app/actions/booking.ts        — the booking write-twin fixed in this unit
//   • app/actions/attendance.ts     — org marks attendance (writes onto the
//                                     spine + republishes the libreta cache);
//                                     guarded in this unit
//   • app/api/mis-mascotas/[publicToken]/libreta-export/route.ts — full Tier-2
//                                     libreta export; its header claimed a
//                                     requirePetAccess gate but the real query
//                                     is an INLINE owner join that lacked the
//                                     term (a surviving live co-owner of an
//                                     erased pet would export everything);
//                                     guarded in this unit
//   • app/actions/return-to-owner.ts — already guarded (unerasedPetByToken,
//                                     defense-in-depth) before this unit
// The fifth is OUT OF CLASS and pinned below. Because the class-membership
// judgement (which readers are third-party-reachable) is DECLARED, not derived,
// this sweep is `guards >= reads` over both trees with one pinned exception —
// coarser than the reachability walk of the public sweep, mechanical in body,
// and honest about resting on the count being small enough to have read every
// reader. A NEW under-guarded reader in either tree fails immediately.
//
// Same counting rule as the sweeps above (`guards >= reads`, comments and
// imports stripped), same stated blind spots (it counts, it does not parse; it
// sees static reads only; RLS is the other half).
// ---------------------------------------------------------------------------

type WriteApiPin = { reads: number; guards: number; reason: string };

/**
 * OUT-OF-CLASS pins — files whose unguarded `pets` read is NOT the art. 16
 * class this fence polices, verified by reading the file. Counts are pinned
 * EXACTLY: add a read (or a guard) and the shape changes, failing this sweep
 * until a human re-reads the file and re-pins it.
 */
const WRITE_API_OUT_OF_CLASS: Record<string, WriteApiPin> = {
  "app/api/cron/reconcile-pet-status/route.ts": {
    reads: 1,
    guards: 0,
    reason:
      "System cron (cron-authenticated, no per-person viewer). It keyset-scans ALL pets to reconcile the pets.status cache against the event spine and backs the 'Deriva de caché' ops card; a soft-deleted pet's cached status must still be reconciled, so filtering deleted_at here would blind a legitimate system job. No per-pet surface, no third-party reachability — out of class, not debt.",
  },
};

function scanWriteApiPetsReaders(): PetsReader[] {
  const out: PetsReader[] = [];
  for (const rootRel of ["app/actions", "app/api"]) {
    const root = resolve(ROOT, rootRel);
    for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.includes(".test.")) continue;
      const full = join(entry.parentPath, entry.name);
      const { reads, guards } = countPetsAccess(readFileSync(full, "utf8"));
      if (reads === 0) continue;
      out.push({ rel: full.slice(`${ROOT}`.length + 1).replaceAll("\\", "/"), reads, guards });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

describe("every write-side/API read of `pets` carries the soft-delete filter (art. 16)", () => {
  const readers = scanWriteApiPetsReaders();
  const violations = readers.filter((r) => r.guards < r.reads);

  it("actually reaches the write/API surfaces it claims to check", () => {
    const rels = readers.map((r) => r.rel);
    // Five readers today; a floor of 4 stays non-vacuous while tolerating one
    // being deleted, and still fails a walk that silently returns nothing.
    expect(readers.length).toBeGreaterThanOrEqual(4);
    // Named anchors: the booking write-twin this unit fixed, its provider-side
    // attendance sibling, the full-libreta export door, and the already-guarded
    // return-to-owner action — the class this fence exists for.
    expect(rels).toContain("app/actions/booking.ts");
    expect(rels).toContain("app/actions/attendance.ts");
    expect(rels).toContain("app/actions/return-to-owner.ts");
    expect(rels).toContain("app/api/mis-mascotas/[publicToken]/libreta-export/route.ts");
  });

  it("has no under-guarded file outside the pinned out-of-class shapes", () => {
    const unexplained = violations.filter((r) => {
      const pin = WRITE_API_OUT_OF_CLASS[r.rel];
      return !pin || pin.reads !== r.reads || pin.guards !== r.guards;
    });
    expect(unexplained).toEqual([]);
  });

  it("carries no stale or drifted pin — a pin describes exactly what was reviewed", () => {
    for (const [rel, pin] of Object.entries(WRITE_API_OUT_OF_CLASS)) {
      const reader = readers.find((r) => r.rel === rel);
      expect(reader, `${rel} no longer reads pets — delete its pin`).toBeDefined();
      expect(
        { reads: reader?.reads, guards: reader?.guards },
        `${rel} changed shape — re-review the file and re-pin`,
      ).toEqual({ reads: pin.reads, guards: pin.guards });
      // A pin is only for an under-guarded shape; a fully guarded file needs none.
      expect(pin.guards).toBeLessThan(pin.reads);
    }
  });
});

// ---------------------------------------------------------------------------
// STATE-OPERATOR TOKEN-DOOR SWEEP (twelfth art. 16 family, 2026-08-29).
//
// The four sweeps above cover public reachability, app/org, app/(app) and
// app/actions+app/api. They left app/gob and app/admin uncovered, and in those
// two trees `deleted_at` / `deletedAt` appeared ZERO times. The obvious move —
// a fifth `guards >= reads` sweep over both trees — is the WRONG one, and this
// header is the measurement that says why.
//
// THE LINE THE REPO ALREADY DREW, and it is not "the state sees everything".
// lib/infra/gob-pet-subview.ts holds TWO loaders that build the SAME projection
// for the SAME roles (admin + govt) and filter OPPOSITELY:
//
//   • loadGobPetSubView   — reachable ONLY through an in-jurisdiction welfare
//     report or case naming this pet (and, for govt, only while that record is
//     non-terminal). Reads `pets` with NO soft-delete term, on purpose.
//   • loadOperatorPetSubView — reachable by JURISDICTION ALONE, addressed by the
//     pet's own token, no linking record required. Carries isNull(pets.deletedAt).
//
// Same official, same screen, different door. So the carve-out is NEXUS, not
// ROLE: a state record about this animal is what survives the citizen's erasure,
// because the state's case does not belong to the citizen. 455a905b4 said the
// same thing from the other side when it closed the org portal — "el carve-out
// de nexo de bienestar es del inspector ESTATAL (loadGobPetSubView), no de un
// org civil". An inspector working an open maltrato file must not be blinded by
// the abuser deleting their account; an operator who merely pasted a token has
// no such claim.
//
// THE MEASUREMENT (run over this tree, not inherited). The PETS_READ regex above
// finds ELEVEN direct `pets` readers under app/gob + app/admin, every one of
// them reads=1 guards=0. Verdict per file, by the nexus rule:
//
//   NEXUS — reached THROUGH a state record's foreign key. Carve-out, unfiltered:
//     app/gob/maltrato/[id]/page.tsx        report.subjectPetId → token, to
//                                           pre-fill the decomiso form. This is
//                                           loadGobPetSubView's own shape.
//     app/gob/moderacion/[id]/page.tsx      report.subjectPetId → token (link).
//     app/admin/moderacion/[id]/page.tsx    its admin twin.
//     app/gob/decomisos/page.tsx            from(cases).leftJoin(pets): the
//                                           custody_episode IS the seizure the
//                                           inspector performed.
//     app/admin/observaciones/[publicToken]/page.tsx
//                                           token-addressed BUT gated on
//                                           isObservationOpen → notFound; an OPEN
//                                           rabies observation (ENO) is a public-
//                                           health nexus, and the open-only gate
//                                           is the stricter form of
//                                           loadGobPetSubView's LOW-2 expiry rule.
//                                           PINNED below — this sweep does see it,
//                                           so it needs a reason on the record
//                                           rather than silence.
//
//   AMBIGUOUS — left OUT, with the reason, because closing them is a product
//   decision this unit does not own:
//     app/gob/disputas/DisputasScreen.tsx
//     app/gob/disputas/[disputeToken]/page.tsx
//                                           from(custodyDisputes).innerJoin(pets),
//                                           rendering pet.name. A custody dispute
//                                           is a state adjudication, but the join
//                                           is INNER: filtering would delete the
//                                           dispute ROW from the operator queue,
//                                           not merely darken a name. The org
//                                           sweep's precedent is the opposite
//                                           shape ("el CASO sigue listado; el
//                                           nombre se apaga via left join
//                                           filtrado"), and turning an inner join
//                                           into a filtered left join on a state
//                                           case queue changes what an
//                                           adjudicator sees. Handed back.
//     app/admin/outbox/page.tsx             petEvents innerJoin pets → token, for
//                                           the "Evento origen" column.
//     app/admin/outbox/[id]/page.tsx        the same resolution, and it reads the
//                                           NAME. Both are platform DELIVERY ops,
//                                           whose nearest decided sibling is the
//                                           PINNED out-of-class cron in
//                                           WRITE_API_OUT_OF_CLASS — a pipeline
//                                           surface, not a per-pet one. Unlike
//                                           that cron it does have a human viewer,
//                                           so it is not obviously out of class
//                                           either. Both reads are SEPARATE
//                                           queries, so a filter would leave the
//                                           outbox row intact and only drop the
//                                           pet link — cheap to do, but "should a
//                                           breach-triage operator see which pet's
//                                           notification failed" is a product
//                                           question. Handed back.
//
//   LEAK — token-addressed with NO state record behind it. FIXED in this unit:
//     app/admin/observaciones/[publicToken]/microchip/reemplazar/page.tsx
//     app/admin/observaciones/[publicToken]/microchip/reemplazar/action.ts
//                                           requireAdminOrRedirect and a token;
//                                           nothing re-checks the observation the
//                                           parent segment gates on. The page put
//                                           the erased pet's NAME in the crumb and
//                                           the heading; the action is hand-
//                                           POSTable. Exactly
//                                           loadOperatorPetSubView's door, which
//                                           the repo already filters.
//
// WHY THE BROAD SWEEP IS NOT SEEDED. After the two fixes, a `guards >= reads`
// rule over app/gob + app/admin would need NINE exceptions on ELEVEN readers.
// 6d47f0479 already made this exact call for app/org before its leaks were
// closed ("Una fence con esa lista silencia el drift en vez de detectarla"), and
// a fence that pins nine of eleven is a list wearing a rule's clothes. The
// measurement above is the deliverable instead; it lives here so the next unit
// starts from a number rather than from a re-count.
//
// WHAT IS SEEDED is the narrow rule the repo's own code already justifies: under
// app/gob + app/admin, a file whose ROUTE addresses the pet by its OWN token
// ([publicToken] / [token]) must carry the soft-delete term, because no state
// record mediates that access. Three readers today, ONE pin, and it catches the
// next token-addressed operator route somebody adds.
//
// WHAT THIS SWEEP CANNOT SEE, stated rather than left to be rediscovered:
//   • It is a PATH rule. A token-addressed door outside app/gob and app/admin is
//     invisible here — loadGobPetSubView itself is token-addressed and unguarded
//     in lib/infra/, and is out of scope on purpose (its nexus arrives AFTER the
//     read, which no path rule can express).
//   • It says nothing about the eight record-mediated readers above. Their
//     verdicts are prose in this header, not assertions.
//   • Same counting blind spots as every sweep above: it counts, it does not
//     parse; static reads only; RLS is the other half.
// ---------------------------------------------------------------------------

type OperatorNexusPin = { reads: number; guards: number; nexus: string };

/**
 * NEXUS pins — token-addressed operator doors whose unguarded `pets` read is the
 * deliberate state carve-out, verified by reading the file. Counts are pinned
 * EXACTLY: add a read (or a guard) and the shape changes, failing this sweep
 * until a human re-reads the file and re-pins it.
 */
const OPERATOR_TOKEN_DOOR_NEXUS: Record<string, OperatorNexusPin> = {
  "app/admin/observaciones/[publicToken]/page.tsx": {
    reads: 1,
    guards: 0,
    nexus:
      "Rabies-observation detail. The route 404s unless isObservationOpen(pet.rabiesObservationStatus) — an OPEN ENO public-health record is the nexus, and it is the stricter form of loadGobPetSubView's LOW-2 rule (access dies with the record, not with the account). A bite victim's 10-day observation cannot be closed by the biter deleting their MiMAR account. govt callers are additionally jurisdiction-scoped; admin is universal, as everywhere else on this tree.",
  },
};

const OPERATOR_SWEEP_ROOTS = ["app/gob", "app/admin"] as const;

/**
 * The pet's OWN token as a route segment. Deliberately exact: `[disputeToken]`
 * addresses the DISPUTE and `[orgToken]` the ORG — in both, the pet arrives
 * through that record, which is the nexus this rule exists to respect. A looser
 * pattern would swallow the custody-dispute queue and turn this fence into the
 * broad sweep the header refuses to seed.
 */
const TOKEN_ADDRESSED_SEGMENT = /\[(?:publicToken|token)\]/;

function scanOperatorTokenDoorPetsReaders(): PetsReader[] {
  const out: PetsReader[] = [];
  for (const rootRel of OPERATOR_SWEEP_ROOTS) {
    const root = resolve(ROOT, rootRel);
    for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.includes(".test.")) continue;
      const full = join(entry.parentPath, entry.name);
      const rel = full.slice(`${ROOT}`.length + 1).replaceAll("\\", "/");
      if (!TOKEN_ADDRESSED_SEGMENT.test(rel)) continue;
      const { reads, guards } = countPetsAccess(readFileSync(full, "utf8"));
      if (reads === 0) continue;
      out.push({ rel, reads, guards });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

describe("every token-addressed operator read of `pets` carries the soft-delete filter (art. 16)", () => {
  const readers = scanOperatorTokenDoorPetsReaders();
  const violations = readers.filter((r) => r.guards < r.reads);

  it("the token-door predicate names the pet's OWN token, not any token-shaped segment", () => {
    // The scoping predicate IS the rule here, so it is pinned before the sweep
    // that rests on it. Widen it and the eight record-mediated readers the header
    // triages flood in; narrow it to nothing and the sweep goes vacuously green.
    expect(TOKEN_ADDRESSED_SEGMENT.test("app/admin/observaciones/[publicToken]/page.tsx")).toBe(
      true,
    );
    expect(TOKEN_ADDRESSED_SEGMENT.test("app/gob/mascotas/[token]/page.tsx")).toBe(true);
    // A dispute token addresses the DISPUTE; the pet arrives through it (nexus).
    expect(TOKEN_ADDRESSED_SEGMENT.test("app/gob/disputas/[disputeToken]/page.tsx")).toBe(false);
    expect(TOKEN_ADDRESSED_SEGMENT.test("app/org/[orgToken]/mascotas/page.tsx")).toBe(false);
    // A numeric record id is not a pet token either.
    expect(TOKEN_ADDRESSED_SEGMENT.test("app/gob/maltrato/[id]/page.tsx")).toBe(false);
  });

  it("actually reaches the operator token doors it claims to check", () => {
    const rels = readers.map((r) => r.rel);
    // Three readers today; the floor tolerates one being deleted and still fails
    // a walk that silently returns nothing.
    expect(readers.length).toBeGreaterThanOrEqual(2);
    expect(rels).toContain("app/admin/observaciones/[publicToken]/page.tsx");
    expect(rels).toContain("app/admin/observaciones/[publicToken]/microchip/reemplazar/page.tsx");
    expect(rels).toContain("app/admin/observaciones/[publicToken]/microchip/reemplazar/action.ts");
    // And it must NOT have swallowed the record-mediated half — those eight are
    // triaged in the header, not policed by this rule. The anchor that carries
    // weight is the DISPUTE detail: it is the only one of the eight whose path
    // has a token-shaped segment at all, so it is the only one a widened
    // predicate can actually pull in. (An earlier version of this test also
    // named decomisos/page.tsx and outbox/page.tsx here — neither path contains
    // a bracket, so no widening could ever have made those assertions fire.
    // Anchors that cannot fail are decoration; they are gone.)
    expect(rels).not.toContain("app/gob/disputas/[disputeToken]/page.tsx");
  });

  it("has no under-guarded file outside the pinned nexus shapes", () => {
    const unexplained = violations.filter((r) => {
      const pin = OPERATOR_TOKEN_DOOR_NEXUS[r.rel];
      return !pin || pin.reads !== r.reads || pin.guards !== r.guards;
    });
    expect(unexplained).toEqual([]);
  });

  it("carries no stale or drifted pin — a pin describes exactly what was reviewed", () => {
    for (const [rel, pin] of Object.entries(OPERATOR_TOKEN_DOOR_NEXUS)) {
      const reader = readers.find((r) => r.rel === rel);
      expect(reader, `${rel} no longer reads pets — delete its pin`).toBeDefined();
      expect(
        { reads: reader?.reads, guards: reader?.guards },
        `${rel} changed shape — re-review the file and re-pin`,
      ).toEqual({ reads: pin.reads, guards: pin.guards });
      // A pin is only for an under-guarded shape; a fully guarded file needs none.
      expect(pin.guards).toBeLessThan(pin.reads);
    }
  });
});
