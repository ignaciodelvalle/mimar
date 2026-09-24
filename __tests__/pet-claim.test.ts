// Action-level tests for app/actions/pet-claim.ts (V1-9 coverage gap).
//
// Covers the two consequential write actions:
//   - submitFreeClaimAction       — direct ownership transfer of a "free" pet
//                                    (no active custody) via ownership_claimed.
//   - submitClaimDisputeAction    — raises a custody dispute against the active
//                                    owner of a chip/tattoo-matched pet.
//
// Strategy mirrors adoption-review.test.ts / chip-match.test.ts: real local
// Postgres + Supabase stack, ephemeral users created/torn down per file, the
// Supabase session mocked via `@/lib/supabase/server`, and the persistent
// rate limiter mocked to allow-by-default (so the success paths aren't tripped
// by leftover buckets, and the rate-limit-rejected path can be forced).

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must be declared before importing the action) -------------------

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Persistent rate limiter — allow by default; individual tests can force a
// throw to exercise the rate-limit-rejected branch.
const { MockRateLimitError, mockEnforceRateLimit } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    resetAt: Date;
    reason: string;
    constructor(resetAt: Date, reason: string) {
      super(`Rate limit exceeded: ${reason}`);
      this.name = "RateLimitError";
      this.resetAt = resetAt;
      this.reason = reason;
    }
  }
  return { MockRateLimitError, mockEnforceRateLimit: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@/lib/infra/rate-limit", () => ({
  enforceRateLimit: (endpoint: string, id: string, cfg: unknown) =>
    mockEnforceRateLimit(endpoint, id, cfg),
  RateLimitError: MockRateLimitError,
}));

// Evidence upload — the dispute writer now REQUIRES at least one attachment
// (PO 2026-07-30), so every success path below has to hand it a real File. The
// bucket leg is stubbed: uploadWelfareEvidence talks to Supabase Storage over
// the network and re-encodes rasters through sharp, neither of which is under
// test here. What the stub preserves is the shape the writer consumes, so the
// attachments-row insert still runs against the real database and can be
// asserted (it never was before — the old tests passed `[]` and skipped it).
const { mockUploadWelfareEvidence, mockRemoveWelfareEvidence } = vi.hoisted(() => ({
  mockUploadWelfareEvidence: vi.fn(),
  mockRemoveWelfareEvidence: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/infra/welfare-uploads", () => ({
  uploadWelfareEvidence: (reportId: string, files: File[]) =>
    mockUploadWelfareEvidence(reportId, files),
  removeWelfareEvidence: (paths: string[]) => mockRemoveWelfareEvidence(paths),
}));

import { submitClaimDisputeAction, submitFreeClaimAction } from "@/app/actions/pet-claim";
import {
  attachments,
  auditLog,
  custodyDisputeParties,
  custodyDisputes,
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  petIdentifications,
  pets,
  profiles,
} from "@/db";
import { createClient } from "@/lib/supabase/server";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const CLAIMANT_EMAIL = "petclaim-claimant@dim-test.local";
const OWNER_EMAIL = "petclaim-owner@dim-test.local";
const ORG_MEMBER_EMAIL = "petclaim-orgmember@dim-test.local";
// A member whose `left_at` is set — the control for "the refusal is keyed on
// ACTIVE membership", which is the only thing that makes the org self-dispute
// guard a rule rather than a blanket ban on disputing org-held animals.
const EX_MEMBER_EMAIL = "petclaim-exmember@dim-test.local";
// A second USER holder, so HOLDER_ROLE_RANK has two rows to choose between.
const CARETAKER_EMAIL = "petclaim-caretaker@dim-test.local";
const PASS = "PetClaim_2026!";

let claimantUserId: string;
let ownerUserId: string;
let orgMemberUserId: string;
let exMemberUserId: string;
let caretakerUserId: string;
let shelterOrgId: string;
const SHELTER_ORG_TOKEN = "DIM-PETCLAIM-ORG1";

const insertedPetIds: string[] = [];

function mockSessionAs(userId: string | null) {
  vi.mocked(createClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: { user: userId ? ({ id: userId } as unknown) : null },
        error: null,
      }),
    },
  } as never);
}

async function purgeUserByEmail(email: string) {
  const { data } = await supabaseAdmin.auth.admin.listUsers();
  const found = data?.users.find((u) => u.email === email);
  const displayName = email.split("@")[0];
  const orphans = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.displayName, displayName));
  const ids = [
    ...(found ? [found.id] : []),
    ...orphans.map((o) => o.id).filter((id) => id !== found?.id),
  ];
  // audit_log is append-only (DELETE blocked by trigger); its actor_user_id FK
  // is ON DELETE SET NULL, so deleting the profile nulls the reference cleanly.
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

// Insert a "free" pet — no owner_user_id, no active ownership row of any role.
async function insertFreePet(token: string, name: string): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name,
      species: "dog",
      status: "active",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning({ id: pets.id });
  insertedPetIds.push(pet.id);
  return pet.id;
}

// Register a microchip identification (the private evidence a free claim now
// requires — the public token is no longer accepted server-side).
const TODAY = new Date().toISOString().slice(0, 10);
async function addMicrochip(petId: string, code: string): Promise<void> {
  await db.insert(petIdentifications).values({
    petId,
    kind: "microchip_iso",
    code,
    recordedAt: TODAY,
  });
}

// Distinct 15-digit chips per dispute scenario. The dispute writer resolves the
// pet FROM the chip, so every scenario needs its own or they collide on the
// active-status partial unique index.
const DISPUTE_OK_CHIP = "900000000000101";
const DISPUTE_SHORT_CHIP = "900000000000102";
const DISPUTE_SELF_CHIP = "900000000000103";
const DISPUTE_DUP_CHIP = "900000000000104";
const VICTIM_CHIP = "900000000000105";
const BYSTANDER_CHIP = "900000000000106";

// A non-empty File — the dispute writer's evidence gate counts only entries
// with size > 0, so a zero-byte placeholder would (correctly) not satisfy it.
function evidenceFile(name = "chip.jpg"): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], name, { type: "image/jpeg" });
}

// Insert a pet with an active owner — direct claim must fail, dispute is the
// path.
async function insertOwnedPet(token: string, name: string, owner: string): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name,
      species: "dog",
      status: "active",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning({ id: pets.id });
  insertedPetIds.push(pet.id);
  // Ownership lives in the ownerships table, not on pets directly.
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId: owner,
    role: "owner",
    startedAt: new Date(),
  });
  return pet.id;
}

// Insert a pet whose ONLY active custody row is an org-held `shelter_custody`
// — `owner_organization_id` set, `owner_user_id` null. This is the population
// the dispute writer used to refuse outright (QA batch 2, D4).
async function insertShelterHeldPet(token: string, name: string, orgId: string): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name,
      species: "dog",
      status: "active",
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning({ id: pets.id });
  insertedPetIds.push(pet.id);
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: new Date(),
  });
  return pet.id;
}

beforeAll(async () => {
  await purgeUserByEmail(CLAIMANT_EMAIL);
  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(ORG_MEMBER_EMAIL);
  await purgeUserByEmail(EX_MEMBER_EMAIL);
  await purgeUserByEmail(CARETAKER_EMAIL);

  const c = await createFreshTestUser(supabaseAdmin, {
    email: CLAIMANT_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (c.error || !c.data.user) throw new Error(`createUser claimant: ${c.error?.message}`);
  claimantUserId = c.data.user.id;

  const o = await createFreshTestUser(supabaseAdmin, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;

  const m = await createFreshTestUser(supabaseAdmin, {
    email: ORG_MEMBER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (m.error || !m.data.user) throw new Error(`createUser org member: ${m.error?.message}`);
  orgMemberUserId = m.data.user.id;

  const x = await createFreshTestUser(supabaseAdmin, {
    email: EX_MEMBER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (x.error || !x.data.user) throw new Error(`createUser ex member: ${x.error?.message}`);
  exMemberUserId = x.data.user.id;

  const k = await createFreshTestUser(supabaseAdmin, {
    email: CARETAKER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (k.error || !k.data.user) throw new Error(`createUser caretaker: ${k.error?.message}`);
  caretakerUserId = k.data.user.id;

  // The shelter that holds the org-custody pets below, plus one active member
  // — the population the org-side notification fans out to.
  await withMutationOverride(async (tx) => {
    await tx.delete(organizations).where(eq(organizations.publicToken, SHELTER_ORG_TOKEN));
  });
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: SHELTER_ORG_TOKEN,
      legalName: "Refugio Reclamos Asociación Civil",
      displayName: "Refugio Reclamos",
      orgType: "shelter",
      email: "petclaim-org@dim-test.local",
      verified: true,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: "La Plata",
    })
    .returning({ id: organizations.id });
  shelterOrgId = org.id;
  await db.insert(organizationMemberships).values({
    organizationId: shelterOrgId,
    userId: orgMemberUserId,
    role: "admin",
    canWritePetEvents: true,
  });
}, 60_000);

afterAll(async () => {
  for (const petId of insertedPetIds) {
    const disputeRows = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    await withMutationOverride(async (tx) => {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, petId));
      // attachments reference pet_events(event_id) — drop them before the
      // events, or the raw DELETE below trips the FK.
      await tx.delete(attachments).where(eq(attachments.petId, petId));
      // pet_events reference cases; null out case links and drop events first.
      await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
      for (const { id } of disputeRows) {
        await tx.delete(custodyDisputeParties).where(eq(custodyDisputeParties.disputeId, id));
      }
      // cases.custody_dispute_id references custodyDisputes; drop cases first.
      await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
      await tx.delete(custodyDisputes).where(eq(custodyDisputes.petId, petId));
      await tx.delete(ownerships).where(eq(ownerships.petId, petId));
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  await withMutationOverride(async (tx) => {
    await tx.delete(organizations).where(eq(organizations.publicToken, SHELTER_ORG_TOKEN));
  });
  await purgeUserByEmail(CLAIMANT_EMAIL);
  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(ORG_MEMBER_EMAIL);
  await purgeUserByEmail(EX_MEMBER_EMAIL);
  await purgeUserByEmail(CARETAKER_EMAIL);
});

beforeEach(() => {
  mockEnforceRateLimit.mockReset();
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockRemoveWelfareEvidence.mockClear();
  // Echo back one stored object per file handed in, so the attachments insert
  // downstream reflects what the writer actually decided to store.
  mockUploadWelfareEvidence.mockReset();
  mockUploadWelfareEvidence.mockImplementation(async (reportId: string, files: File[]) => {
    const uploaded = files.map((f, i) => ({
      storagePath: `${reportId}/${i}-${f.name}`,
      mimeType: f.type,
      fileSize: f.size,
      originalFilename: f.name,
    }));
    return { error: null, uploaded, uploadedPaths: uploaded.map((u) => u.storagePath) };
  });
});

// ---------------------------------------------------------------------------
// submitFreeClaimAction
// ---------------------------------------------------------------------------

describe("submitFreeClaimAction", () => {
  it("claims a free pet: creates owner ownership + ownership_claimed event + audit row", async () => {
    const token = "DIM-CLAIM-FREE-1";
    const chip = "100000000000001";
    const petId = await insertFreePet(token, "Libre Uno");
    await addMicrochip(petId, chip);
    mockSessionAs(claimantUserId);

    const result = await submitFreeClaimAction({
      identifierKind: "microchip",
      identifierValue: chip,
    });

    expect(result).toEqual({ petToken: token, petName: "Libre Uno" });

    // Ownership row now exists for the claimant.
    const [own] = await db
      .select({ ownerUserId: ownerships.ownerUserId, role: ownerships.role })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), isNull(ownerships.endedAt)))
      .limit(1);
    expect(own?.ownerUserId).toBe(claimantUserId);
    expect(own?.role).toBe("owner");

    // ownership_claimed event written.
    const [evt] = await db
      .select({ eventType: petEvents.eventType, payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "ownership_claimed")))
      .limit(1);
    expect(evt).toBeDefined();
    expect((evt.payload as { claimed_by_user_id: string }).claimed_by_user_id).toBe(claimantUserId);
    expect((evt.payload as { identifier_kind: string }).identifier_kind).toBe("microchip");

    // Audit row written.
    const [audit] = await db
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .where(and(eq(auditLog.actorUserId, claimantUserId), eq(auditLog.action, "free_pet_claimed")))
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect(audit).toBeDefined();
    expect((audit.payload as { pet_id: string }).pet_id).toBe(petId);
  });

  it("rejects when the rate limit is exceeded", async () => {
    const token = "DIM-CLAIM-FREE-RL";
    const chip = "100000000000002";
    const petId = await insertFreePet(token, "Rate Limited");
    await addMicrochip(petId, chip);
    mockSessionAs(claimantUserId);
    mockEnforceRateLimit.mockRejectedValueOnce(new MockRateLimitError(new Date(), "minute"));

    const result = await submitFreeClaimAction({
      identifierKind: "microchip",
      identifierValue: chip,
    });

    // THE CODE TRAVELS BESIDE THE SENTENCE since the failure arm was typed
    // (`ClaimFailureCode`): the prose is written for the web wizard's error
    // paragraph and the code is what `POST /api/v1/me/pet-claims` maps to a
    // status. Asserted here, against real Postgres, so the pairing is pinned on
    // the path that actually runs the writer — the route test mocks the use-case
    // and can therefore only pin what it is handed.
    expect(result).toEqual({
      error: "Demasiados intentos. Probá en unos minutos.",
      code: "rate_limited",
    });
  });

  it("rejects claiming a pet that already has active custody (FOR UPDATE re-check)", async () => {
    const token = "DIM-CLAIM-OWNED-1";
    const chip = "100000000000003";
    const petId = await insertOwnedPet(token, "Ya Tiene Dueño", ownerUserId);
    await addMicrochip(petId, chip);
    mockSessionAs(claimantUserId);

    const result = await submitFreeClaimAction({
      identifierKind: "microchip",
      identifierValue: chip,
    });

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("custodia activa");
    // `not_claimable` and NOT `not_found`: the animal exists and this caller may
    // not have it. The API door answers 409 for the first and 404 for the second,
    // and the difference is what a client is told to do next.
    expect((result as { code: string }).code).toBe("not_claimable");

    // No second ownership row was created for the claimant.
    const claimantRows = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), eq(ownerships.ownerUserId, claimantUserId)));
    expect(claimantRows).toHaveLength(0);
  });

  // ART. 16 — AN ERASED PET IS INDISTINGUISHABLE FROM ONE THAT NEVER EXISTED.
  //
  // `pet_identifications` rows survive an erasure with `status = 'active'`, so
  // the chip still resolves and the writer used to fall through to its status
  // guards. These two cases are the two things that produced, and they are
  // measured against real Postgres because the second one WROTE.
  it("answers not_found for an ERASED pet, not the 409 that would out it", async () => {
    const token = "DIM-CLAIM-ERASED-OWNED";
    const chip = "100000000000010";
    const petId = await insertOwnedPet(token, "Borrada Con Dueño", ownerUserId);
    await addMicrochip(petId, chip);
    await db.update(pets).set({ deletedAt: new Date() }).where(eq(pets.id, petId));
    mockSessionAs(claimantUserId);

    const result = await submitFreeClaimAction({
      identifierKind: "microchip",
      identifierValue: chip,
    });

    // THE ORACLE THIS CLOSES: before the fix this answered `not_claimable` —
    // "esta mascota ya tiene una custodia activa" — while an unregistered chip
    // answered `not_found`. The API door maps the first to 409 and the second to
    // 404, so any self-registered account could read "this animal was erased"
    // off the status line. Both must now be the SAME answer.
    expect((result as { code: string }).code).toBe("not_found");
    expect((result as { error: string }).error).toBe("No encontramos la mascota.");
  });

  it("does not CLAIM an erased pet that has no active custody", async () => {
    // THE GRAVE ONE. With no active custody there was nothing left to refuse on:
    // the writer inserted the ownership, appended `ownership_claimed` to the
    // spine, notified and audited, and handed back the animal's name and public
    // token — while `lookupForClaim` on the same door answered `not_found` for
    // the same chip.
    const token = "DIM-CLAIM-ERASED-FREE";
    const chip = "100000000000011";
    const petId = await insertFreePet(token, "Borrada Sin Dueño");
    await addMicrochip(petId, chip);
    await db.update(pets).set({ deletedAt: new Date() }).where(eq(pets.id, petId));
    mockSessionAs(claimantUserId);

    const result = await submitFreeClaimAction({
      identifierKind: "microchip",
      identifierValue: chip,
    });

    expect((result as { code: string }).code).toBe("not_found");

    // AND NOTHING WAS WRITTEN. The refusal is only half the property — a writer
    // that answered `not_found` after committing would satisfy the assertion
    // above and still have transferred the animal.
    const ownershipRows = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(and(eq(ownerships.petId, petId), eq(ownerships.ownerUserId, claimantUserId)));
    expect(ownershipRows).toHaveLength(0);

    const eventRows = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "ownership_claimed")));
    expect(eventRows).toHaveLength(0);
  });

  // EVIDENCE GATE (audit 26-#6). Knowing a pet's PUBLIC token is NOT enough to
  // claim it — the writer resolves the pet from the PRIVATE identifier value and
  // never trusts a caller-supplied token. An unknown identifier resolves to
  // nothing and the claim is rejected, even for a real free pet.
  it("rejects a claim when the identifier value does not resolve to any pet", async () => {
    const token = "DIM-CLAIM-NOEVIDENCE";
    await insertFreePet(token, "Sin Evidencia");
    // No microchip registered → the free pet exists but the bare token is useless.
    mockSessionAs(claimantUserId);

    const result = await submitFreeClaimAction({
      identifierKind: "microchip",
      identifierValue: "199999999999999",
    });
    expect(result).toEqual({ error: "No encontramos la mascota.", code: "not_found" });

    // The pet was NOT claimed — no ownership row exists for the claimant.
    const [pet] = await db.select({ id: pets.id }).from(pets).where(eq(pets.publicToken, token));
    const rows = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(and(eq(ownerships.petId, pet.id), eq(ownerships.ownerUserId, claimantUserId)));
    expect(rows).toHaveLength(0);
  });

  it("rejects a microchip that is not exactly 15 digits before any lookup", async () => {
    mockSessionAs(claimantUserId);
    const result = await submitFreeClaimAction({
      identifierKind: "microchip",
      identifierValue: "12345",
    });
    expect(result).toEqual({
      error: "El microchip debe tener exactamente 15 dígitos.",
      code: "identifier_invalid",
    });
  });
});

// ---------------------------------------------------------------------------
// submitClaimDisputeAction
// ---------------------------------------------------------------------------
//
// EVERY call below used to pass `files: []` and four of them asserted SUCCESS
// on it — the happy path, the first leg of the duplicate-dispute test, the
// wrong-chip resolution test and the authorRole test. Read together they
// pinned "a custody dispute opens with zero proof" as the contract, which is
// what the writer did and what the PO decided on 2026-07-30 it must stop
// doing. They were not testing evidence — they were testing the dispute
// mechanics, and `[]` was the cheapest literal to write — but a passing suite
// is a claim about behaviour regardless of intent, and this one certified a
// permanent accusation against a third party as free. They now hand the writer
// a real attachment, which also makes each one isolate its own rule instead of
// riding on a gate that did not exist. The evidence rule itself is pinned in
// its own describe at the bottom of this file.

describe("submitClaimDisputeAction", () => {
  it("raises a dispute: custody_dispute row + raising event + parties + audit + owner flag", async () => {
    const token = "DIM-DISPUTE-OK-1";
    const petId = await insertOwnedPet(token, "Disputado", ownerUserId);
    mockSessionAs(claimantUserId);

    await addMicrochip(petId, DISPUTE_OK_CHIP);
    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: DISPUTE_OK_CHIP,
        reason: "Es mi perro, lo perdí hace dos meses y lo reconozco.",
      },
      [evidenceFile()],
    );

    expect(result).toHaveProperty("disputeToken");
    const disputeToken = (result as { disputeToken: string }).disputeToken;
    expect(disputeToken.startsWith("DIS")).toBe(true);

    // Dispute row open, pet flagged.
    const [dispute] = await db
      .select({ id: custodyDisputes.id, status: custodyDisputes.status })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);
    expect(dispute?.status).toBe("open");

    const [pet] = await db
      .select({ inCustodyDispute: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(pet?.inCustodyDispute).toBe(true);

    // Raising event written with raised_by_role=owner.
    const [evt] = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_dispute_raised")))
      .limit(1);
    expect((evt.payload as { raised_by_role: string }).raised_by_role).toBe("owner");

    // Both initial parties registered.
    const parties = await db
      .select({ role: custodyDisputeParties.partyRole })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.disputeId, dispute.id));
    const roles = parties.map((p) => p.role).sort();
    expect(roles).toEqual(["claimant_owner", "current_owner"]);

    // Audit row.
    const [audit] = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.actorUserId, claimantUserId),
          eq(auditLog.action, "claim_dispute_submitted"),
        ),
      )
      .orderBy(desc(auditLog.performedAt))
      .limit(1);
    expect((audit.payload as { dispute_public_token: string }).dispute_public_token).toBe(
      disputeToken,
    );
  });

  it("rejects a reason shorter than 20 characters", async () => {
    const token = "DIM-DISPUTE-SHORT";
    const petId = await insertOwnedPet(token, "Razon Corta", ownerUserId);
    await addMicrochip(petId, DISPUTE_SHORT_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      { identifierKind: "microchip", identifierValue: DISPUTE_SHORT_CHIP, reason: "mía" },
      [evidenceFile()],
    );
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("al menos 20 caracteres");
  });

  it("rejects when the claimant is already the registered owner", async () => {
    const token = "DIM-DISPUTE-SELF";
    const petId = await insertOwnedPet(token, "Ya Es Mío", claimantUserId);
    await addMicrochip(petId, DISPUTE_SELF_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: DISPUTE_SELF_CHIP,
        reason: "Quiero reclamar mi propia mascota registrada acá.",
      },
      [evidenceFile()],
    );
    expect(result).toEqual({ error: "Esta mascota ya está registrada a tu nombre." });
  });

  // ART. 16 — THE SIBLING HOLE THE FREE-CLAIM FIX MISSED, found by the
  // 2026-09-01 pre-push review: the dispute door resolved the chip with a bare
  // join, so an erased pet answered "figura como fallecida" or "no tiene dueño
  // activo registrado" — both distinguishable from never-existed — and with a
  // surviving active-owner row (ownerships outlive an erasure by design) a full
  // dispute could be RAISED against the erased spine. Same clause, same single
  // answer, measured against real Postgres because the grave case WROTE.
  it("answers not_found for an ERASED pet with an active owner, and writes NOTHING", async () => {
    const token = "DIM-DISPUTE-ERASED-OWNED";
    const chip = "100000000000012";
    const petId = await insertOwnedPet(token, "Disputa Borrada Con Dueño", ownerUserId);
    await addMicrochip(petId, chip);
    await db.update(pets).set({ deletedAt: new Date() }).where(eq(pets.id, petId));
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: chip,
        reason: "Es mi perro, lo reconozco por la mancha del lomo.",
      },
      [evidenceFile()],
    );

    // ONE answer, the one that says nothing — not the deceased leak, not the
    // no-active-owner leak, and above all not a disputeToken.
    expect(result).toEqual({ error: "No encontramos la mascota." });

    // And the accusation machinery never ran: no case, no spine event, no flag.
    const disputes = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    expect(disputes).toHaveLength(0);

    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_dispute_raised")));
    expect(events).toHaveLength(0);

    const [pet] = await db
      .select({ inCustodyDispute: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(pet?.inCustodyDispute).toBe(false);
  });

  it("answers the SAME not_found for an ERASED pet with no owner", async () => {
    // Kills the second oracle: without the clause this path answered "Esta
    // mascota no tiene dueño activo registrado", which reads "it existed".
    const token = "DIM-DISPUTE-ERASED-FREE";
    const chip = "100000000000013";
    const petId = await insertFreePet(token, "Disputa Borrada Sin Dueño");
    await addMicrochip(petId, chip);
    await db.update(pets).set({ deletedAt: new Date() }).where(eq(pets.id, petId));
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: chip,
        reason: "La encontré en la calle hace meses y la cuidé yo.",
      },
      [evidenceFile()],
    );

    expect(result).toEqual({ error: "No encontramos la mascota." });
  });

  it("rejects raising a second dispute while one is already open", async () => {
    const token = "DIM-DISPUTE-DUP";
    const petId = await insertOwnedPet(token, "Doble Disputa", ownerUserId);
    await addMicrochip(petId, DISPUTE_DUP_CHIP);
    mockSessionAs(claimantUserId);

    const first = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: DISPUTE_DUP_CHIP,
        reason: "Primera disputa con motivo suficientemente largo.",
      },
      [evidenceFile()],
    );
    expect(first).toHaveProperty("disputeToken");

    const second = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: DISPUTE_DUP_CHIP,
        reason: "Segunda disputa con motivo suficientemente largo.",
      },
      [evidenceFile()],
    );
    expect(second).toHaveProperty("error");
    expect((second as { error: string }).error).toContain("disputa abierta");

    // Still exactly one dispute row for this pet.
    const disputes = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    expect(disputes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The denial-of-rescue attack — the private identifier is the authorization
// ---------------------------------------------------------------------------
//
// The writer used to take a caller-supplied `petToken` straight into the WHERE
// behind nothing but requireUserOrRedirect. /perdidas lists every lost animal
// with a link to /p/{token} and no login, so a free account could scrape tokens
// and dispute each one. Each raise flips pets.in_custody_dispute, which the
// public credential page reads to null out the owner's name, phone, email, the
// finder form and the sighting form — stripping the only channel by which a
// finder reaches the owner, on exactly the animals that need it.
//
// These drive the REAL action against the REAL database. The type no longer
// admits a pet token at all, so the residual runtime question is whether the
// identifier actually binds: an attacker holding a DIFFERENT pet's chip, or no
// valid chip, must not be able to touch the victim.

/** The victim's flag and spine must both be untouched. */
async function assertUntouched(petId: string) {
  const [pet] = await db
    .select({ inCustodyDispute: pets.inCustodyDispute })
    .from(pets)
    .where(eq(pets.id, petId))
    .limit(1);
  expect(pet?.inCustodyDispute).toBe(false);

  const raised = await db
    .select({ id: petEvents.id })
    .from(petEvents)
    .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_dispute_raised")));
  expect(raised).toHaveLength(0);

  const disputes = await db
    .select({ id: custodyDisputes.id })
    .from(custodyDisputes)
    .where(eq(custodyDisputes.petId, petId));
  expect(disputes).toHaveLength(0);
}

describe("dispute authorization — the identifier binds, the token is gone", () => {
  it("a chip that belongs to ANOTHER pet cannot dispute the victim", async () => {
    const victimId = await insertOwnedPet("DIM-VICTIM-XPET", "Victima", ownerUserId);
    await addMicrochip(victimId, VICTIM_CHIP);
    const bystanderId = await insertOwnedPet("DIM-BYSTANDER-1", "Ajena", ownerUserId);
    await addMicrochip(bystanderId, BYSTANDER_CHIP);
    mockSessionAs(claimantUserId);

    // The attacker holds the victim's public token (harvested from /perdidas)
    // but only a DIFFERENT animal's chip. The request can only ever name the
    // animal the chip resolves to.
    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: BYSTANDER_CHIP,
        reason: "Intento apuntar a la victima usando el chip de otro animal.",
      },
      [evidenceFile()],
    );

    // It resolved to the bystander, never to the victim.
    expect(result).toHaveProperty("petToken");
    expect((result as { petToken: string }).petToken).toBe("DIM-BYSTANDER-1");
    await assertUntouched(victimId);
  });

  it("an unknown chip disputes nothing at all", async () => {
    const victimId = await insertOwnedPet("DIM-VICTIM-NOCHIP", "Victima2", ownerUserId);
    await addMicrochip(victimId, "900000000000107");
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: "900000000000999",
        reason: "Un chip que no existe no puede disputar ninguna mascota.",
      },
      [evidenceFile()],
    );

    expect(result).toEqual({ error: "No encontramos la mascota." });
    await assertUntouched(victimId);
  });

  it("an empty identifier is rejected before anything is written", async () => {
    const victimId = await insertOwnedPet("DIM-VICTIM-EMPTY", "Victima3", ownerUserId);
    await addMicrochip(victimId, "900000000000108");
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: "   ",
        reason: "Sin identificador no se puede abrir ninguna disputa.",
      },
      [evidenceFile()],
    );

    // Pin the EMPTY-value message specifically, not just "some error". Dropping
    // the `if (!identifierValue)` guard is otherwise a behaviour-preserving
    // mutation: whitespace trims to "" and the 15-digit pattern rejects it a
    // line later, so the security property (nothing written) survives either
    // way. What the guard actually buys is the better message — asking for the
    // number rather than complaining about its length — so that is what this
    // asserts. assertUntouched below still pins the security property itself.
    expect(result).toEqual({
      error: "Ingresá el número de microchip o el código del tatuaje.",
    });
    await assertUntouched(victimId);
  });

  it("an empty TATTOO identifier is rejected too — no pattern check backs that kind up", async () => {
    const victimId = await insertOwnedPet("DIM-VICTIM-EMPTYTAT", "Victima5", ownerUserId);
    await addMicrochip(victimId, "900000000000111");
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "tattoo",
        identifierValue: "",
        reason: "Un tatuaje vacio tampoco puede abrir una disputa.",
      },
      [evidenceFile()],
    );

    expect(result).toEqual({
      error: "Ingresá el número de microchip o el código del tatuaje.",
    });
    await assertUntouched(victimId);
  });

  it("a retired (replaced) chip no longer authorizes a dispute", async () => {
    const victimId = await insertOwnedPet("DIM-VICTIM-RETIRED", "Victima4", ownerUserId);
    const retired = "900000000000109";
    await db.insert(petIdentifications).values({
      petId: victimId,
      kind: "microchip_iso",
      code: retired,
      recordedAt: TODAY,
      status: "replaced",
    });
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: retired,
        reason: "Un chip dado de baja no debe seguir habilitando la disputa.",
      },
      [evidenceFile()],
    );

    expect(result).toEqual({ error: "No encontramos la mascota." });
    await assertUntouched(victimId);
  });

  it("signs the raising event authorRole=finder — the claimant is NOT the owner", async () => {
    const petId = await insertOwnedPet("DIM-DISPUTE-ROLE", "Atribucion", ownerUserId);
    const chip = "900000000000110";
    await addMicrochip(petId, chip);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: chip,
        reason: "La atribucion del evento debe decir la verdad sobre quien escribe.",
      },
      [evidenceFile()],
    );
    expect(result).toHaveProperty("disputeToken");

    // The guard above this insert refuses when the claimant IS the registered
    // owner, so reaching the insert proves they are not. The timeline renders
    // author_role verbatim as "Dueño/a" — signing it "owner" showed the real
    // owner an accusation against themselves apparently written by themselves.
    // Append-only (invariant #2): a false attribution cannot be edited later.
    const [evt] = await db
      .select({ authorRole: petEvents.authorRole, recordedByUserId: petEvents.recordedByUserId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_dispute_raised")))
      .limit(1);
    expect(evt.recordedByUserId).toBe(claimantUserId);
    expect(evt.authorRole).toBe("finder");
    expect(evt.authorRole).not.toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// The evidence gate — a permanent accusation is not free (PO 2026-07-30)
// ---------------------------------------------------------------------------
//
// The identifier binding (above) killed bulk abuse against arbitrary animals.
// It does not touch the cost of ONE dispute against the one animal whose chip
// the claimant knows — a vet, a shelter volunteer, a previous fosterer or the
// person who sold the animal all know that number. For that pet the writer
// still accepted 20 characters of prose and nothing else, and produced: an
// accusatory notification to the registered owner, an uneditable
// custody_dispute_raised row on their spine, in_custody_dispute=true (which
// strips their contact channel off the public credential) and a case the local
// authority has to adjudicate. At least one attachment is the floor, and it is
// enforced HERE — the wizard's `required` is a browser courtesy, this action is
// independently addressable.

describe("dispute evidence gate — the accusation needs proof", () => {
  const NO_EVIDENCE_ERROR =
    "Adjuntá al menos una foto o un video como prueba. Una disputa le avisa a la persona registrada como dueña y queda asentada de forma permanente, así que la autoridad necesita ver algo concreto para poder revisarla.";

  it("refuses a dispute with zero attachments — nothing written, no rate-limit budget spent", async () => {
    const petId = await insertOwnedPet("DIM-DISPUTE-NOEV", "Sin Prueba", ownerUserId);
    const chip = "900000000000112";
    await addMicrochip(petId, chip);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: chip,
        reason: "Es mi perro y lo reconozco perfectamente por la mancha del lomo.",
      },
      [],
    );

    // Pin the MESSAGE, not merely "some error". A `toHaveProperty("error")`
    // here would be satisfied by every other rejection in this writer — the
    // reason gate, the identifier gate, "no encontramos la mascota" — so it
    // would survive deleting the evidence gate entirely.
    expect(result).toEqual({ error: NO_EVIDENCE_ERROR });

    // The gate sits BEFORE enforceRateLimit, matching the convention the rest
    // of this codebase follows: a submission rejected on validation alone must
    // not burn the caller's budget and block their corrected retry.
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();

    // And nothing was uploaded — the gate runs before the bucket is touched.
    expect(mockUploadWelfareEvidence).not.toHaveBeenCalled();

    await assertUntouched(petId);
  });

  it("a zero-byte file does not count as evidence", async () => {
    const petId = await insertOwnedPet("DIM-DISPUTE-EMPTYF", "Archivo Vacio", ownerUserId);
    const chip = "900000000000113";
    await addMicrochip(petId, chip);
    mockSessionAs(claimantUserId);

    // An <input type="file"> that was touched and cleared, or a client that
    // appends a placeholder, submits a File with size 0. uploadWelfareEvidence
    // filters those out downstream, so counting raw `files.length` would open
    // the dispute and then store nothing — the exact state the gate exists to
    // prevent.
    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: chip,
        reason: "Un archivo vacio no prueba nada y no debe alcanzar para acusar.",
      },
      [new File([], "vacio.jpg", { type: "image/jpeg" })],
    );

    expect(result).toEqual({ error: NO_EVIDENCE_ERROR });
    await assertUntouched(petId);
  });

  it("one real attachment opens the dispute AND is stored against the raising event", async () => {
    const petId = await insertOwnedPet("DIM-DISPUTE-WITHEV", "Con Prueba", ownerUserId);
    const chip = "900000000000114";
    await addMicrochip(petId, chip);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: chip,
        reason: "Adjunto la foto del chip escaneado en la veterinaria del barrio.",
      },
      [evidenceFile("chip-escaneado.jpg")],
    );
    expect(result).toHaveProperty("disputeToken");

    // The gate is a floor, not a wall: with proof the dispute still opens.
    const [pet] = await db
      .select({ inCustodyDispute: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(pet?.inCustodyDispute).toBe(true);

    // The evidence has to reach the authority, not just satisfy a counter:
    // it lands on the attachments table linked to the raising event, which is
    // what the case surfaces render.
    const [raisingEvent] = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_dispute_raised")))
      .limit(1);
    const rows = await db
      .select({ eventId: attachments.eventId, storagePath: attachments.storagePath })
      .from(attachments)
      .where(eq(attachments.petId, petId));
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe(raisingEvent.id);
    expect(rows[0].storagePath).toContain("chip-escaneado.jpg");
  });
});

// ---------------------------------------------------------------------------
// D4 — the counter-party can be an ORGANISATION
// ---------------------------------------------------------------------------
//
// The holder lookup was `eq(ownerships.role, "owner")`, so an animal whose only
// live custody row is a refugio's `shelter_custody` (owner_organization_id set,
// owner_user_id null) answered "Esta mascota no tiene dueño activo registrado."
// — a sentence that is false about the animal AND contradicts the step before
// it: `lookupForClaimForUser` asks `hasAnyActiveCustody` with no role filter, so
// the wizard offered "Iniciar disputa" for exactly this population, and the
// mobile lookup says it out loud ("ya está bajo la custodia de otra persona u
// organización"). QA batch 2 measured it on Toby DIM-3UVE-9QH8 held by Refugio
// Test: full submit with evidence, `in_custody_dispute` still false, no event.
//
// Nothing in the schema was in the way. `custody_dispute_parties` has carried
// `party_organization_id` (with its FK and index) and the `current_org_custody`
// role since migration 0025, and `PARTY_ROLE_LABELS` already names it
// "Organización en custodia".

const ORG_DISPUTE_CHIP = "900000000000201";
const ORG_NOTIFY_CHIP = "900000000000202";
const NO_CUSTODY_CHIP = "900000000000203";
const SELF_CUSTODY_CHIP = "900000000000204";

describe("dispute against an org-held animal (D4)", () => {
  it("opens the dispute and files the REFUGIO as the counter-party, not nobody", async () => {
    const petId = await insertShelterHeldPet("DIM-ORGHELD-1", "Toby Refugiado", shelterOrgId);
    await addMicrochip(petId, ORG_DISPUTE_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: ORG_DISPUTE_CHIP,
        reason: "Es mi perro, se escapó en marzo y el refugio lo levantó de la calle.",
      },
      [evidenceFile()],
    );

    // The refusal that used to be the ONLY outcome here.
    expect(result).not.toEqual({ error: "Esta mascota no tiene dueño activo registrado." });
    expect(result).toHaveProperty("disputeToken");
    const disputeToken = (result as { disputeToken: string }).disputeToken;

    const [dispute] = await db
      .select({ id: custodyDisputes.id, status: custodyDisputes.status })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);
    expect(dispute?.status).toBe("open");

    // The flag QA watched, and the spine row behind it.
    const [pet] = await db
      .select({ inCustodyDispute: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(pet?.inCustodyDispute).toBe(true);

    const raised = await db
      .select({ payload: petEvents.payload, authorRole: petEvents.authorRole })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_dispute_raised")));
    expect(raised).toHaveLength(1);
    // `raised_by_role` is the CAPACITY axis (a private party asserting
    // ownership) and stays "owner" whoever the holder is; `authorRole` is who
    // wrote the row, and the claimant is demonstrably not the holder.
    expect((raised[0].payload as { raised_by_role: string }).raised_by_role).toBe("owner");
    expect(raised[0].authorRole).toBe("finder");

    // The counter-party is the ORG, on the org column, under the org role.
    const parties = await db
      .select({
        role: custodyDisputeParties.partyRole,
        userId: custodyDisputeParties.partyUserId,
        orgId: custodyDisputeParties.partyOrganizationId,
      })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.disputeId, dispute.id));
    expect(parties.map((p) => p.role).sort()).toEqual(["claimant_owner", "current_org_custody"]);

    const counterparty = parties.find((p) => p.role === "current_org_custody");
    expect(counterparty?.orgId).toBe(shelterOrgId);
    // The CHECK `dispute_party_exactly_one_subject` allows exactly one subject:
    // an org party that also carried a user id could not have been inserted,
    // and one that carried neither would render "Desconocido" to the official.
    expect(counterparty?.userId).toBeNull();

    const claimantParty = parties.find((p) => p.role === "claimant_owner");
    expect(claimantParty?.userId).toBe(claimantUserId);
    expect(claimantParty?.orgId).toBeNull();
  });

  it("tells the refugio — a blocked adoption pipeline is not something to discover", async () => {
    const petId = await insertShelterHeldPet("DIM-ORGHELD-2", "Nala Refugiada", shelterOrgId);
    await addMicrochip(petId, ORG_NOTIFY_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: ORG_NOTIFY_CHIP,
        reason: "La reconozco por la cicatriz de la pata, es la mía sin ninguna duda.",
      },
      [evidenceFile()],
    );
    expect(result).toHaveProperty("disputeToken");

    const memberNotifications = await db
      .select({
        notificationType: notifications.notificationType,
        ctaUrl: notifications.ctaUrl,
        severity: notifications.severity,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgMemberUserId),
          eq(notifications.relatedPetId, petId),
          eq(notifications.notificationType, "custody_dispute_raised_against_you"),
        ),
      );
    expect(memberNotifications).toHaveLength(1);
    expect(memberNotifications[0].severity).toBe("warning");
    // The ORG portal, addressed by public tokens on both segments — an org
    // member has no /mis-mascotas page for an animal they hold.
    expect(memberNotifications[0].ctaUrl).toBe("/org/DIM-PETCLAIM-ORG1/mascotas/DIM-ORGHELD-2");
  });

  it("still refuses an animal NOBODY holds, with the sentence unchanged", async () => {
    // The refusal is load-bearing elsewhere: the erased-pet tests above rely on
    // this sentence NOT being the answer for a soft-deleted animal, so widening
    // the lookup must not have widened the refusal away.
    const petId = await insertFreePet("DIM-NOCUSTODY-1", "Sin Custodia");
    await addMicrochip(petId, NO_CUSTODY_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: NO_CUSTODY_CHIP,
        reason: "Quiero disputar un animal que no tiene ninguna custodia activa.",
      },
      [evidenceFile()],
    );
    expect(result).toEqual({ error: "Esta mascota no tiene dueño activo registrado." });

    const disputes = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    expect(disputes).toHaveLength(0);
  });

  it("refuses a self-dispute by a NON-titular holder without claiming titularidad", async () => {
    // The widened lookup can now resolve the caller's own custody row. Refusing
    // is right — nobody disputes themselves — but "ya está registrada a tu
    // nombre" would be a lie told to a caretaker, who holds without owning.
    const petId = await insertFreePet("DIM-SELFCUSTODY-1", "Bajo Mi Cuidado");
    await db.insert(ownerships).values({
      petId,
      ownerUserId: claimantUserId,
      role: "caretaker",
      startedAt: new Date(),
    });
    await addMicrochip(petId, SELF_CUSTODY_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: SELF_CUSTODY_CHIP,
        reason: "Ya la tengo yo, pero igual quiero abrir una disputa contra mí mismo.",
      },
      [evidenceFile()],
    );
    expect(result).toEqual({ error: "Ya tenés la custodia activa de esta mascota." });
    expect(result).not.toEqual({ error: "Esta mascota ya está registrada a tu nombre." });

    const disputes = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    expect(disputes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The self-dispute guard, and the sponsorship PAIR
// ---------------------------------------------------------------------------
// Two defects found by the 2026-09-04 fresh review of the org-held fix above,
// both of them the same shape: the widened lookup returns a SET, and the two
// things reading it still read row zero.
//
//   · THE GUARD. `holder.ownerUserId === userId` compares against NULL on an
//     org row, so a member of the very shelter that holds the animal could
//     dispute it — flipping `in_custody_dispute` on their own adoption
//     pipeline, filing their own organisation as the counter-party and
//     notifying their colleagues. A claimant holding a lower-ranked row
//     (foster, caretaker) under somebody else's top row escaped for the same
//     reason: the comparison never saw their row.
//   · THE PAIR. `db/schema.ts` says a live `owner` row and a live org
//     `shelter_custody` row coexist — that IS the rehome-by-titular
//     sponsorship. Filing only the rank-winner left the other subject out of a
//     proceeding that stops them both.
//
// HOLDER_ROLE_RANK gets a test here for the first time. It is only observable
// where TWO user rows compete, which is exactly the titular-vs-caretaker pair
// `scripts/check-titular-row-resolution.ts` exists for.

const SELF_ORG_CHIP = "900000000000211";
const FOSTER_SELF_CHIP = "900000000000212";
const EX_MEMBER_CHIP = "900000000000213";
const SPONSORSHIP_CHIP = "900000000000214";
const RANK_CARETAKER_CHIP = "900000000000215";

describe("nobody disputes themselves — and that includes their refugio", () => {
  it("refuses an ACTIVE member of the shelter that holds the animal", async () => {
    const petId = await insertShelterHeldPet("DIM-SELFORG-1", "Perro Del Refugio", shelterOrgId);
    await addMicrochip(petId, SELF_ORG_CHIP);
    // `orgMemberUserId` is an active `admin` of `shelterOrgId` (beforeAll).
    mockSessionAs(orgMemberUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: SELF_ORG_CHIP,
        reason: "Trabajo en el refugio que lo tiene y quiero abrir una disputa contra nosotros.",
      },
      [evidenceFile()],
    );

    // Its own sentence: the two existing refusals both claim a PERSONAL
    // relationship this caller does not have — no row here carries their name.
    expect(result).toEqual({ error: "Tu organización ya tiene la custodia de esta mascota." });

    // Nothing written: no dispute, and the flag that blocks the shelter's own
    // adoption pipeline was never flipped.
    const disputes = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    expect(disputes).toHaveLength(0);
    const [blocked] = await db
      .select({ inCustodyDispute: pets.inCustodyDispute })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    expect(blocked?.inCustodyDispute).toBe(false);
  });

  it("refuses a claimant holding a LOWER-ranked row on an org-held animal", async () => {
    // The org's `shelter_custody` outranks a user `foster` row, so the old
    // guard only ever compared against the org row — and the foster, who is
    // holding the animal, was allowed to dispute it.
    const petId = await insertShelterHeldPet("DIM-FOSTERSELF-1", "En Transito", shelterOrgId);
    await db.insert(ownerships).values({
      petId,
      ownerUserId: claimantUserId,
      role: "foster",
      startedAt: new Date(),
    });
    await addMicrochip(petId, FOSTER_SELF_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: FOSTER_SELF_CHIP,
        reason: "Lo tengo yo en transito, pero igual quiero disputar la custodia del refugio.",
      },
      [evidenceFile()],
    );

    // A foster holds without owning, so "registrada a tu nombre" would be the
    // lie the caretaker case above already refuses to tell.
    expect(result).toEqual({ error: "Ya tenés la custodia activa de esta mascota." });

    const disputes = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.petId, petId));
    expect(disputes).toHaveLength(0);
  });

  it("still allows a DEPARTED member — the refusal is keyed on ACTIVE membership", async () => {
    // The control that makes the guard a rule about `left_at IS NULL` rather
    // than about org-held animals in general (an unrelated stranger is already
    // covered by "files the REFUGIO as the counter-party" above, where the
    // claimant belongs to no organisation at all). `isActiveOrgMember` is the
    // shared definition; a private copy that dropped the clause refuses here.
    const petId = await insertShelterHeldPet("DIM-EXMEMBER-1", "Ex Colega", shelterOrgId);
    await addMicrochip(petId, EX_MEMBER_CHIP);
    await db.insert(organizationMemberships).values({
      organizationId: shelterOrgId,
      userId: exMemberUserId,
      role: "volunteer",
      leftAt: new Date(),
    });
    mockSessionAs(exMemberUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: EX_MEMBER_CHIP,
        reason: "Ya no trabajo en ese refugio y creo que ese animal es mio desde antes.",
      },
      [evidenceFile()],
    );
    expect(result).toHaveProperty("disputeToken");
  });
});

describe("the sponsorship pair — a titular AND the org that sponsors the listing", () => {
  it("files BOTH as parties and tells both", async () => {
    const petId = await insertOwnedPet("DIM-SPONSOR-1", "Apadrinado", ownerUserId);
    // The second live row the schema explicitly permits alongside `owner`:
    // "a live owner row and a live shelter_custody row CAN coexist — that pair
    // is the rehome-by-titular sponsorship".
    await db.insert(ownerships).values({
      petId,
      ownerOrganizationId: shelterOrgId,
      role: "shelter_custody",
      startedAt: new Date(),
    });
    await addMicrochip(petId, SPONSORSHIP_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: SPONSORSHIP_CHIP,
        reason: "Es mi perro, lo publicaron en adopcion y el refugio lo esta apadrinando.",
      },
      [evidenceFile()],
    );
    expect(result).toHaveProperty("disputeToken");
    const disputeToken = (result as { disputeToken: string }).disputeToken;

    const [dispute] = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);

    const parties = await db
      .select({
        role: custodyDisputeParties.partyRole,
        userId: custodyDisputeParties.partyUserId,
        orgId: custodyDisputeParties.partyOrganizationId,
      })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.disputeId, dispute.id));

    // THREE parties, not two. The org used to be dropped on this exact shape.
    expect(parties.map((p) => p.role).sort()).toEqual([
      "claimant_owner",
      "current_org_custody",
      "current_owner",
    ]);
    expect(parties.find((p) => p.role === "current_owner")?.userId).toBe(ownerUserId);
    expect(parties.find((p) => p.role === "current_org_custody")?.orgId).toBe(shelterOrgId);

    // Both legs notified — the branch used to be `if user … else if org`, so
    // the org heard nothing on the one case where its listing is what stops.
    const ownerNotifications = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.relatedPetId, petId),
          eq(notifications.notificationType, "custody_dispute_raised_against_you"),
        ),
      );
    expect(ownerNotifications).toHaveLength(1);

    const orgNotifications = await db
      .select({ ctaUrl: notifications.ctaUrl })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, orgMemberUserId),
          eq(notifications.relatedPetId, petId),
          eq(notifications.notificationType, "custody_dispute_raised_against_you"),
        ),
      );
    expect(orgNotifications).toHaveLength(1);
    expect(orgNotifications[0].ctaUrl).toBe("/org/DIM-PETCLAIM-ORG1/mascotas/DIM-SPONSOR-1");
  });

  it("HOLDER_ROLE_RANK picks the TITULAR over the caretaker holding the animal", async () => {
    // The rank is only observable where two USER rows compete, and this is the
    // pair `scripts/check-titular-row-resolution.ts` was written for: seven
    // shipped defects, every one of them a caretaker's identity served where
    // the titular's belonged. Swap `owner` and `caretaker` inside
    // HOLDER_ROLE_RANK and both assertions below fail.
    const petId = await insertOwnedPet("DIM-RANKCARE-1", "Con Cuidadora", ownerUserId);
    await db.insert(ownerships).values({
      petId,
      ownerUserId: caretakerUserId,
      role: "caretaker",
      startedAt: new Date(),
    });
    await addMicrochip(petId, RANK_CARETAKER_CHIP);
    mockSessionAs(claimantUserId);

    const result = await submitClaimDisputeAction(
      {
        identifierKind: "microchip",
        identifierValue: RANK_CARETAKER_CHIP,
        reason: "Es mi perro y ahora lo tiene una cuidadora que no conozco de nada.",
      },
      [evidenceFile()],
    );
    expect(result).toHaveProperty("disputeToken");
    const disputeToken = (result as { disputeToken: string }).disputeToken;

    const [dispute] = await db
      .select({ id: custodyDisputes.id })
      .from(custodyDisputes)
      .where(eq(custodyDisputes.publicToken, disputeToken))
      .limit(1);

    const parties = await db
      .select({ role: custodyDisputeParties.partyRole, userId: custodyDisputeParties.partyUserId })
      .from(custodyDisputeParties)
      .where(eq(custodyDisputeParties.disputeId, dispute.id));
    // ONE counter-party, and it is the titular. Two live user rows do not make
    // two counter-parties — the rank chooses which one answers the claim.
    expect(parties.map((p) => p.role).sort()).toEqual(["claimant_owner", "current_owner"]);
    expect(parties.find((p) => p.role === "current_owner")?.userId).toBe(ownerUserId);

    // And the accusation reached the titular, not the cuidadora.
    const caretakerNotifications = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, caretakerUserId), eq(notifications.relatedPetId, petId)));
    expect(caretakerNotifications).toHaveLength(0);
    const titularNotifications = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.relatedPetId, petId),
          eq(notifications.notificationType, "custody_dispute_raised_against_you"),
        ),
      );
    expect(titularNotifications).toHaveLength(1);
  });
});
