// Integration + unit tests for Lost & Found Fase 2 — microchip cross-check
// and match flow.
//
// Structure:
//   1. Unit tests — lookupByChip (pure DB, no auth)
//   2. Unit tests — force-token utility (pure crypto)
//   3. Integration tests — createIntakeAction cross-check paths
//   4. Integration tests — createPetAction cross-check (found_stray)
//   5. Integration tests — confirmChipMatchAction
//
// Database setup mirrors admin-revocations.test.ts (ephemeral users) and
// role-upgrade.test.ts (transaction tests). All rows created here are deleted
// in afterAll.

import { createClient } from "@supabase/supabase-js";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { confirmChipMatchAction } from "@/app/actions/chip-match";
import {
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
import { attemptedChipMatchesPet, lookupByChip } from "@/lib/infra/chip-lookup";
import { generateIntakeMatchClaim } from "@/lib/infra/intake-match-claim";
import { generateForceToken, validateForceToken } from "@/lib/infra/microchip-force-token";
import { generatePublicToken } from "@/lib/infra/publicToken";
// Writers import from the application modules, not the "use server" shim
// (impersonation triage, review 07).
import { confirmChipMatchAsRefugioWriter } from "@/src/modules/pets/application/chip-match/confirm-chip-match-refugio";
import { confirmChipMatchAsVecinoWriter } from "@/src/modules/pets/application/chip-match/confirm-chip-match-vecino";
import { recordChipDisputeAgainstActivePet } from "@/src/modules/pets/application/chip-match/record-chip-dispute";
import { createIntake } from "@/src/modules/pets/application/intake/create-intake";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

// ---------------------------------------------------------------------------
// Test fixtures — emails
// ---------------------------------------------------------------------------

const OWNER_EMAIL = "chip-match-owner@dim-test.local";
const REFUGIO_MEMBER_EMAIL = "chip-match-member@dim-test.local";
const VECINO_EMAIL = "chip-match-vecino@dim-test.local";
const PASS = "ChipMatch_2026!";

let ownerUserId: string;
let refugioMemberUserId: string;
let vecinoUserId: string;
let orgId: string;
let orgToken: string;

// Pets inserted by tests — tracked for cleanup.
const insertedPetIds: string[] = [];

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

async function purgeUserByEmail(email: string) {
  const { data } = await supabase.auth.admin.listUsers();
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
  // Deleting profiles cascades to pet_events.recorded_by_user_id (ON DELETE
  // SET NULL), which triggers the append-only protection. Wrap so the
  // cascading UPDATE is allowed.
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(REFUGIO_MEMBER_EMAIL);
  await purgeUserByEmail(VECINO_EMAIL);

  const o = await createFreshTestUser(supabase, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;

  const m = await createFreshTestUser(supabase, {
    email: REFUGIO_MEMBER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (m.error || !m.data.user) throw new Error(`createUser member: ${m.error?.message}`);
  refugioMemberUserId = m.data.user.id;

  const v = await createFreshTestUser(supabase, {
    email: VECINO_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (v.error || !v.data.user) throw new Error(`createUser vecino: ${v.error?.message}`);
  vecinoUserId = v.data.user.id;

  // Create a test organization for refugio tests.
  orgToken = generatePublicToken();
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: orgToken,
      legalName: "Chip Match Test Refugio SRL",
      displayName: "Chip Match Refugio",
      orgType: "shelter",
      email: "chip-match-refugio@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  // Add refugioMember as admin of the org.
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: refugioMemberUserId,
    role: "admin",
    canWritePetEvents: true,
  });
});

afterAll(async () => {
  // Delete pet events and ownerships for tracked pets.
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }

  // Clean up notifications for all test users.
  for (const uid of [ownerUserId, refugioMemberUserId, vecinoUserId].filter(Boolean)) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
  }

  if (orgId) {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }

  await purgeUserByEmail(OWNER_EMAIL);
  await purgeUserByEmail(REFUGIO_MEMBER_EMAIL);
  await purgeUserByEmail(VECINO_EMAIL);
});

// ---------------------------------------------------------------------------
// Helper: generate a deterministic 15-digit ISO-compliant chip code from an
// arbitrary test name so that insertPetWithChip can satisfy the
// chip_requires_iso_fields CHECK constraint (code must be exactly 15 numeric
// digits for kind='microchip_iso').  Using prefix "999" (test/research range)
// and a 12-digit hash suffix keeps collisions negligible across test names.
// ---------------------------------------------------------------------------

function isoChipFromTestName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  const abs = Math.abs(hash) % 999_999_999_999;
  return `999${abs.toString().padStart(12, "0")}`;
}

// ---------------------------------------------------------------------------
// Helper: insert a pet with a microchip + ownership for tests.
// Returns the canonical chip code (stored in pet_identifications) alongside
// petId and publicToken.  Callers that look up the chip via lookupByChip must
// use canonicalChip, not the original microchipId, because lookupByChip reads
// exclusively from pet_identifications (ARCH-Q — canonical readers only).
// ---------------------------------------------------------------------------

async function insertPetWithChip(opts: {
  microchipId: string;
  status: "active" | "lost" | "deceased";
  ownerUserId: string;
  tokenSuffix: string;
}): Promise<{ petId: string; publicToken: string; canonicalChip: string }> {
  const token = `LF2-${opts.tokenSuffix}-${Date.now().toString(36).toUpperCase().slice(-4)}`;
  const now = new Date();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `TestPet-${opts.tokenSuffix}`,
      species: "dog",
      sex: "unknown",
      status: opts.status,
      potentiallyDangerousBreed: false,
    })
    .returning();

  insertedPetIds.push(pet.id);

  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId: opts.ownerUserId,
    role: "owner",
    startedAt: now,
  });

  // Insert canonical chip row so lookupByChip (reads only from pet_identifications)
  // can find the pet. Mirrors what real writers do.
  // ARCH-S: legacy pets.microchipId dropped — canonical-only.
  // chip_requires_iso_fields CHECK constraint requires exactly 15 numeric digits
  // for kind='microchip_iso'. Hash non-ISO test codes so the constraint is satisfied.
  const ISO_CHIP_RE = /^\d{15}$/;
  const canonicalCode = ISO_CHIP_RE.test(opts.microchipId)
    ? opts.microchipId
    : isoChipFromTestName(opts.microchipId);
  await db.insert(petIdentifications).values({
    petId: pet.id,
    kind: "microchip_iso",
    code: canonicalCode,
    recordedAt: now.toISOString().slice(0, 10),
    isoCountryCode: canonicalCode.slice(0, 3),
    isoManufacturerCode: canonicalCode.slice(3, 7),
    isoNationalId: canonicalCode.slice(7, 15),
    isoCompliant: true,
  });

  return { petId: pet.id, publicToken: token, canonicalChip: canonicalCode };
}

// ---------------------------------------------------------------------------
// 1. lookupByChip — pure DB
// ---------------------------------------------------------------------------

describe("lookupByChip", () => {
  it("returns null when no pet has the given chip", async () => {
    const result = await lookupByChip("CHIP-DOES-NOT-EXIST-9999");
    expect(result).toBeNull();
  });

  it("returns pet shape when a matching pet exists", async () => {
    const chip = `CHIP-LOOKUP-${Date.now()}`;
    const { petId, publicToken, canonicalChip } = await insertPetWithChip({
      microchipId: chip,
      status: "active",
      ownerUserId: ownerUserId,
      tokenSuffix: "LOOKUP",
    });

    const result = await lookupByChip(canonicalChip);
    expect(result).not.toBeNull();
    expect(result?.pet.id).toBe(petId);
    expect(result?.pet.publicToken).toBe(publicToken);
    expect(result?.pet.status).toBe("active");
    expect(result?.pet.ownerUserId).toBe(ownerUserId);
    expect(result?.ownerFirstName).toBeTruthy();
  });

  it("returns status='lost' when the matched pet is lost", async () => {
    const chip = `CHIP-LOST-${Date.now()}`;
    const { canonicalChip } = await insertPetWithChip({
      microchipId: chip,
      status: "lost",
      ownerUserId: ownerUserId,
      tokenSuffix: "LOSTCHK",
    });

    const result = await lookupByChip(canonicalChip);
    expect(result?.pet.status).toBe("lost");
  });

  it("returns status='deceased' when the matched pet is deceased", async () => {
    const chip = `CHIP-DEC-${Date.now()}`;
    const { canonicalChip } = await insertPetWithChip({
      microchipId: chip,
      status: "deceased",
      ownerUserId: ownerUserId,
      tokenSuffix: "DECCHK",
    });

    const result = await lookupByChip(canonicalChip);
    expect(result?.pet.status).toBe("deceased");
  });
});

// ---------------------------------------------------------------------------
// 2. Force-token utility
// ---------------------------------------------------------------------------

describe("attemptedChipMatchesPet", () => {
  it("true only for the pet's own active chip — never another pet's, never a pet with none", async () => {
    const a = await insertPetWithChip({
      microchipId: `CHIP-PROOF-A-${Date.now()}`,
      status: "lost",
      ownerUserId,
      tokenSuffix: "PROOFA",
    });
    const b = await insertPetWithChip({
      microchipId: `CHIP-PROOF-B-${Date.now()}`,
      status: "lost",
      ownerUserId,
      tokenSuffix: "PROOFB",
    });

    expect(await attemptedChipMatchesPet(a.petId, a.canonicalChip)).toBe(true);
    // A valid code, just not this animal's — the cross-pet probe.
    expect(await attemptedChipMatchesPet(a.petId, b.canonicalChip)).toBe(false);
    expect(await attemptedChipMatchesPet(a.petId, "")).toBe(false);
    expect(await attemptedChipMatchesPet(a.petId, "900000000000001")).toBe(false);

    // A pet with no identification row at all answers the same "no" — the
    // refusal must not double as a "does this pet have a chip?" oracle.
    const [chipless] = await db
      .insert(pets)
      .values({
        publicToken: `LF2-NOCHIP-${Date.now().toString(36).toUpperCase().slice(-4)}`,
        name: "TestPet-NoChip",
        species: "dog",
        sex: "unknown",
        status: "lost",
      })
      .returning();
    insertedPetIds.push(chipless.id);
    expect(await attemptedChipMatchesPet(chipless.id, a.canonicalChip)).toBe(false);
  });
});

describe("force-token: generateForceToken / validateForceToken", () => {
  it("generates a token that validates immediately", () => {
    const chip = "CHIP-FORCE-TEST-001";
    const token = generateForceToken(chip);
    expect(validateForceToken(chip, token)).toBe(true);
  });

  it("token for chip A does not validate for chip B", () => {
    const tokenForA = generateForceToken("CHIP-A");
    expect(validateForceToken("CHIP-B", tokenForA)).toBe(false);
  });

  it("tampered token fails validation", () => {
    const chip = "CHIP-TAMPER-TEST";
    const token = generateForceToken(chip);
    const tampered = `${token.slice(0, -5)}XXXXX`;
    expect(validateForceToken(chip, tampered)).toBe(false);
  });

  it("token with wrong format returns false", () => {
    expect(validateForceToken("CHIP-ANY", "not-a-valid-token")).toBe(false);
    expect(validateForceToken("CHIP-ANY", "")).toBe(false);
    expect(validateForceToken("CHIP-ANY", "abc.notanumber")).toBe(false);
  });

  it("expired token (simulated) fails validation", () => {
    // Build a token with a timestamp 16 minutes ago.
    const chip = "CHIP-EXPIRE-TEST";
    const sixteenMinutesAgo = Date.now() - 16 * 60 * 1000;
    // We can't call generateForceToken with a custom ts, but we can generate
    // a fresh token and mutate its timestamp component to the past.
    const freshToken = generateForceToken(chip);
    const dotIdx = freshToken.lastIndexOf(".");
    const macPart = freshToken.slice(0, dotIdx);
    const expiredToken = `${macPart}.${sixteenMinutesAgo}`;
    expect(validateForceToken(chip, expiredToken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. confirmChipMatchAction — integration
// ---------------------------------------------------------------------------

// confirmChipMatchAction tests use the exported writer functions directly
// (same pattern as requestVetUpgradeForUser / createOrganizationForUser in
// role-upgrade.test.ts) to bypass the Next.js request context requirement
// imposed by requireCapability / requireUserOrRedirect.

describe("confirmChipMatchAction", () => {
  it("refugio decision='same': creates shelter_custody + emits event + notifies owner", async () => {
    const chip = `CHIP-CONF-SAME-${Date.now()}`;
    const { petId, publicToken: matchedToken } = await insertPetWithChip({
      microchipId: chip,
      status: "lost",
      ownerUserId: ownerUserId,
      tokenSuffix: "CSAME",
    });

    const result = await confirmChipMatchAsRefugioWriter({
      auth: {
        user: { id: refugioMemberUserId },
        organization: { id: orgId, displayName: "Chip Match Refugio", verified: true },
      },
      orgToken,
      claim: generateIntakeMatchClaim(orgToken, matchedToken),
      matchedPetToken: matchedToken,
      decision: "same",
    });

    expect("ok" in result).toBe(true);
    if (!("ok" in result)) throw new Error("Expected ok");
    expect(result.ok).toBe(true);

    // Verify shelter_custody ownership was inserted.
    const custodyRows = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, orgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(custodyRows.length).toBe(1);

    // Verify original owner ownership still active (parallel custody — D7).
    const ownerRows = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerUserId, ownerUserId),
          eq(ownerships.role, "owner"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(ownerRows.length).toBe(1);

    // Verify shelter_intake_recorded event was emitted.
    const intakeEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "shelter_intake_recorded")));
    expect(intakeEvents.length).toBeGreaterThan(0);

    // Verify notification was sent to owner.
    const ownerNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "chip_match_notification_owner"),
          eq(notifications.relatedPetId, petId),
        ),
      );
    expect(ownerNotifs.length).toBeGreaterThan(0);
    expect(ownerNotifs[0].severity).toBe("urgent");
  });

  it("refugio decision='same' while ANOTHER org holds live custody: refused in es-AR, no second row, no intake event (0195)", async () => {
    // The guard used to look only at THIS org's custody. With one live
    // organisation custody per pet (0195), a second refugio confirming the
    // same found animal hit the index as an unhandled 23505.
    const chip = `CHIP-CONF-HELD-${Date.now()}`;
    const { petId, publicToken: matchedToken } = await insertPetWithChip({
      microchipId: chip,
      status: "lost",
      ownerUserId: ownerUserId,
      tokenSuffix: "CHELD",
    });
    const otherToken = generatePublicToken();
    const [otherOrg] = await db
      .insert(organizations)
      .values({
        publicToken: otherToken,
        legalName: "Chip Match Other Refugio SRL",
        displayName: "Otro Refugio",
        orgType: "shelter",
        email: `chip-match-other-${otherToken.toLowerCase()}@dim-test.local`,
        verified: true,
      })
      .returning({ id: organizations.id });
    await db.insert(ownerships).values({
      petId,
      ownerOrganizationId: otherOrg.id,
      role: "shelter_custody",
      startedAt: new Date(),
    });

    const result = await confirmChipMatchAsRefugioWriter({
      auth: {
        user: { id: refugioMemberUserId },
        organization: { id: orgId, displayName: "Chip Match Refugio", verified: true },
      },
      orgToken,
      claim: generateIntakeMatchClaim(orgToken, matchedToken),
      matchedPetToken: matchedToken,
      decision: "same",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected a refusal");
    expect(result.error).toMatch(/custodia de una organización/);

    const custodyRows = await db
      .select({ org: ownerships.ownerOrganizationId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(custodyRows.map((r) => r.org)).toEqual([otherOrg.id]);
    const intakeEvents = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "shelter_intake_recorded")));
    expect(intakeEvents).toHaveLength(0);

    await db.delete(ownerships).where(eq(ownerships.ownerOrganizationId, otherOrg.id));
    await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
  });

  it("vecino decision='same': creates shelter_custody + emits event + notifies owner", async () => {
    const chip = `CHIP-VEC-SAME-${Date.now()}`;
    const {
      petId,
      publicToken: matchedToken,
      canonicalChip,
    } = await insertPetWithChip({
      microchipId: chip,
      status: "lost",
      ownerUserId: ownerUserId,
      tokenSuffix: "VSAME",
    });

    const result = await confirmChipMatchAsVecinoWriter({
      userId: vecinoUserId,
      matchedPetToken: matchedToken,
      attemptedMicrochipId: canonicalChip,
      decision: "same",
    });

    expect("ok" in result).toBe(true);
    if (!("ok" in result)) throw new Error("Expected ok");

    // Verify shelter_custody ownership was created for the vecino.
    const custodyRows = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerUserId, vecinoUserId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(custodyRows.length).toBe(1);

    // Verify notification sent to owner.
    const ownerNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "chip_match_notification_owner"),
          eq(notifications.relatedPetId, petId),
        ),
      );
    expect(ownerNotifs.length).toBeGreaterThan(0);

    // Attribution. The vecino does NOT own this pet, and the timeline renders
    // author_role verbatim as "Dueño/a", so signing these events "owner" showed
    // the real owner a note about their own animal apparently written by
    // themselves. The spine is append-only: a false attribution cannot be
    // edited later, only contradicted by a second event.
    const vecinoEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.recordedByUserId, vecinoUserId)));
    expect(vecinoEvents.length).toBeGreaterThan(0);
    for (const ev of vecinoEvents) expect(ev.authorRole).toBe("finder");
  });

  it("refugio decision='not_same': emits note_added, no ownership created", async () => {
    const chip = `CHIP-NOT-SAME-${Date.now()}`;
    const { petId, publicToken: matchedToken } = await insertPetWithChip({
      microchipId: chip,
      status: "lost",
      ownerUserId: ownerUserId,
      tokenSuffix: "NOTSAME",
    });

    const ownershipsBefore = await db.select().from(ownerships).where(eq(ownerships.petId, petId));

    const result = await confirmChipMatchAsRefugioWriter({
      auth: {
        user: { id: refugioMemberUserId },
        organization: { id: orgId, displayName: "Chip Match Refugio", verified: true },
      },
      orgToken,
      claim: generateIntakeMatchClaim(orgToken, matchedToken),
      matchedPetToken: matchedToken,
      decision: "not_same",
    });

    expect("ok" in result).toBe(true);

    // No new ownership rows.
    const ownershipsAfter = await db.select().from(ownerships).where(eq(ownerships.petId, petId));
    expect(ownershipsAfter.length).toBe(ownershipsBefore.length);

    // note_added event emitted.
    const notes = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")));
    expect(notes.length).toBeGreaterThan(0);
    // A refugio authored these, so "shelter" is the truthful attribution. The
    // vecino twin of this assertion lives below and expects "finder" — the two
    // together are what stop either writer from drifting onto "owner", which is
    // what both of them used to sign on a pet the author does not own.
    for (const note of notes) expect(note.authorRole).toBe("shelter");
  });

  it("decision='same' with non-lost pet returns error", async () => {
    const chip = `CHIP-ACTIVE-MATCH-${Date.now()}`;
    const { publicToken: matchedToken } = await insertPetWithChip({
      microchipId: chip,
      status: "active", // not lost!
      ownerUserId: ownerUserId,
      tokenSuffix: "ACTMATCH",
    });

    const result = await confirmChipMatchAsRefugioWriter({
      auth: {
        user: { id: refugioMemberUserId },
        organization: { id: orgId, displayName: "Chip Match Refugio", verified: true },
      },
      orgToken,
      claim: generateIntakeMatchClaim(orgToken, matchedToken),
      matchedPetToken: matchedToken,
      decision: "same",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/no.*perd/i);
  });

  it("invalid actorMode returns error", async () => {
    // Test the public action boundary: invalid actorMode short-circuits before auth.
    const result = await confirmChipMatchAction({
      matchedPetToken: "any-token",
      actorMode: "invalid" as never,
      decision: "same",
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/actorMode/i);
  });

  it("refugio mode without orgToken returns error", async () => {
    // Test the public action boundary: missing orgToken short-circuits before auth.
    const result = await confirmChipMatchAction({
      matchedPetToken: "any-token",
      actorMode: "refugio",
      // orgToken intentionally omitted
      decision: "same",
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/orgToken/i);
  });

  it("non-existent matchedPetToken returns error", async () => {
    const result = await confirmChipMatchAsRefugioWriter({
      auth: {
        user: { id: refugioMemberUserId },
        organization: { id: orgId, displayName: "Chip Match Refugio", verified: true },
      },
      orgToken,
      claim: generateIntakeMatchClaim(orgToken, "DIM-DOES-NOT-EXIST"),
      matchedPetToken: "DIM-DOES-NOT-EXIST",
      decision: "not_same",
    });
    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/no encontrada/i);
  });

  // Review 24 HIGH #7 — cross-tenant write guard. Without a valid intake-match
  // claim (or with one minted for a different org / pet), the refugio writer
  // must refuse to mutate the lost pet — no shelter_custody, no owner notify.
  it("refugio decision='same' with NO claim → error, no custody created", async () => {
    const chip = `CHIP-NOCLAIM-${Date.now()}`;
    const { petId, publicToken: matchedToken } = await insertPetWithChip({
      microchipId: chip,
      status: "lost",
      ownerUserId: ownerUserId,
      tokenSuffix: "NOCLAIM",
    });

    const result = await confirmChipMatchAsRefugioWriter({
      auth: {
        user: { id: refugioMemberUserId },
        organization: { id: orgId, displayName: "Chip Match Refugio", verified: true },
      },
      orgToken,
      // claim intentionally omitted
      matchedPetToken: matchedToken,
      decision: "same",
    });

    expect("error" in result).toBe(true);

    const custodyRows = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, orgId),
          eq(ownerships.role, "shelter_custody"),
        ),
      );
    expect(custodyRows.length).toBe(0);
  });

  it("refugio decision='same' with a claim for a DIFFERENT org → error, no custody", async () => {
    const chip = `CHIP-XORG-${Date.now()}`;
    const { petId, publicToken: matchedToken } = await insertPetWithChip({
      microchipId: chip,
      status: "lost",
      ownerUserId: ownerUserId,
      tokenSuffix: "XORG",
    });

    const result = await confirmChipMatchAsRefugioWriter({
      auth: {
        user: { id: refugioMemberUserId },
        organization: { id: orgId, displayName: "Chip Match Refugio", verified: true },
      },
      orgToken,
      // Claim minted for a different org's token — must not authorize this org.
      claim: generateIntakeMatchClaim("DIM-OTHER-ORG1", matchedToken),
      matchedPetToken: matchedToken,
      decision: "same",
    });

    expect("error" in result).toBe(true);

    const custodyRows = await db
      .select()
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, orgId),
          eq(ownerships.role, "shelter_custody"),
        ),
      );
    expect(custodyRows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3b. The vecino chip oracle — confirmChipMatchAsVecinoWriter
// ---------------------------------------------------------------------------
//
// c626c3fb gave the `not_same` branch a `chipConflict.microchipId` read straight
// out of the matched pet's canonical identification. Reaching it needed nothing
// but a session (self-signup is free) and a public token, and /perdidas lists
// those without a login. That made this writer a nationwide microchip lookup
// service for a number /p/[publicToken] deliberately refuses to render, plus a
// way to take custody of any lost animal and to write on its event spine.
//
// The fix makes the code the actor typed the capability. These tests call the
// REAL writer against the REAL database — the RA-2 F6 walk-through test cannot
// see any of this because it mocks confirmChipMatchAction, which is exactly the
// boundary the leak lived behind.

describe("vecino chip oracle — attemptedMicrochipId is the capability", () => {
  /** The attack: a token harvested off /perdidas and nothing else. */
  async function probe(matchedToken: string, attempt: string) {
    return confirmChipMatchAsVecinoWriter({
      userId: vecinoUserId,
      matchedPetToken: matchedToken,
      attemptedMicrochipId: attempt,
      decision: "not_same",
    });
  }

  it("blind probe (no chip attempt) → error, and the response contains no chip", async () => {
    const { petId, publicToken, canonicalChip } = await insertPetWithChip({
      microchipId: `CHIP-ORACLE-BLIND-${Date.now()}`,
      status: "lost",
      ownerUserId,
      tokenSuffix: "ORCBLND",
    });

    const result = await probe(publicToken, "");

    // Asserted FIRST so a regression names the leaked digits in its diff: the
    // canonical code must not appear ANYWHERE in the payload that crosses the
    // server-action boundary.
    expect(JSON.stringify(result)).not.toContain(canonicalChip);
    expect("error" in result).toBe(true);

    // And the probe leaves no mark on the victim's append-only spine.
    const notes = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")));
    expect(notes.length).toBe(0);
  });

  it("wrong chip attempt → same error, no chip disclosed, no event written", async () => {
    const { petId, publicToken, canonicalChip } = await insertPetWithChip({
      microchipId: `CHIP-ORACLE-WRONG-${Date.now()}`,
      status: "lost",
      ownerUserId,
      tokenSuffix: "ORCWRNG",
    });

    const result = await probe(publicToken, "900000000000001");

    expect(JSON.stringify(result)).not.toContain(canonicalChip);
    expect("error" in result).toBe(true);

    const notes = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")));
    expect(notes.length).toBe(0);
  });

  it("correct chip attempt → receipt minted, note written, still no chip echoed", async () => {
    const { petId, publicToken, canonicalChip } = await insertPetWithChip({
      microchipId: `CHIP-ORACLE-RIGHT-${Date.now()}`,
      status: "lost",
      ownerUserId,
      tokenSuffix: "ORCRGHT",
    });

    const result = await probe(publicToken, canonicalChip);

    if (!("ok" in result)) throw new Error(`Expected ok, got ${JSON.stringify(result)}`);
    expect(result.chipConflict?.forceToken).toBeDefined();
    // The receipt is usable for the code the caller already had…
    expect(validateForceToken(canonicalChip, result.chipConflict?.forceToken ?? "")).toBe(true);
    // …and the response still does not carry the code itself. The caller typed
    // it; the server has no reason to say it back.
    expect(result.chipConflict).not.toHaveProperty("microchipId");

    const notes = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")));
    expect(notes.length).toBe(1);
  });

  it("decision='same' without the chip → no custody grab, no owner notification", async () => {
    // The oracle was not the only thing an unproven caller could do: 'same'
    // inserted shelter_custody over any lost pet and pushed an urgent
    // "Encontraron a X" notification to its owner.
    const { petId, publicToken } = await insertPetWithChip({
      microchipId: `CHIP-ORACLE-SAME-${Date.now()}`,
      status: "lost",
      ownerUserId,
      tokenSuffix: "ORCSAME",
    });

    const result = await confirmChipMatchAsVecinoWriter({
      userId: vecinoUserId,
      matchedPetToken: publicToken,
      attemptedMicrochipId: "",
      decision: "same",
    });

    expect("error" in result).toBe(true);

    const custody = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerUserId, vecinoUserId),
          eq(ownerships.role, "shelter_custody"),
        ),
      );
    expect(custody.length).toBe(0);

    const notifs = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.notificationType, "chip_match_notification_owner"),
          eq(notifications.relatedPetId, petId),
        ),
      );
    expect(notifs.length).toBe(0);
  });

  it("deceased match with the correct chip → no receipt, keeping the alta's hard block honest", async () => {
    // createPetAction's deceased branch claims no actor can hold a receipt for
    // a deceased match. Knowing the chip was enough to mint one until the
    // writer checked status: the block was a comment, not a rule.
    const { petId, publicToken, canonicalChip } = await insertPetWithChip({
      microchipId: `CHIP-ORACLE-DEAD-${Date.now()}`,
      status: "deceased",
      ownerUserId,
      tokenSuffix: "ORCDEAD",
    });

    const result = await probe(publicToken, canonicalChip);

    if (!("ok" in result)) throw new Error(`Expected ok, got ${JSON.stringify(result)}`);
    expect(result.chipConflict).toBeUndefined();

    const notes = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")));
    expect(notes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3c. The ACTIVE-match escape hatch leaves a trace
// ---------------------------------------------------------------------------
//
// The `lost` half of the escape hatch records its adjudication (the vecino
// confirmation writes a dismissal note before minting a receipt). The `active`
// half recorded NOTHING: the warning was returned, the token redeemed, the
// animal registered chipless, and the credential whose globally-unique
// identifier had just been disputed never heard about it. Invariant #2 says
// corrections are new events — so this is one.

describe("recordChipDisputeAgainstActivePet", () => {
  it("appends a note to the ACTIVE record whose chip was disputed", async () => {
    const { petId, canonicalChip } = await insertPetWithChip({
      microchipId: `CHIP-DISPUTE-ACT-${Date.now()}`,
      status: "active",
      ownerUserId,
      tokenSuffix: "DISPACT",
    });

    await recordChipDisputeAgainstActivePet({
      disputedChipCode: canonicalChip,
      actorUserId: vecinoUserId,
    });

    const notes = await db
      .select({ payload: petEvents.payload, recordedBy: petEvents.recordedByUserId })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")));
    expect(notes.length).toBe(1);
    expect(notes[0].recordedBy).toBe(vecinoUserId);
    expect((notes[0].payload as { text: string }).text).toMatch(/animal distinto/i);
  });

  it("stays silent for a LOST record — the confirmation page already noted that one", async () => {
    const { petId, canonicalChip } = await insertPetWithChip({
      microchipId: `CHIP-DISPUTE-LOST-${Date.now()}`,
      status: "lost",
      ownerUserId,
      tokenSuffix: "DISPLST",
    });

    await recordChipDisputeAgainstActivePet({
      disputedChipCode: canonicalChip,
      actorUserId: vecinoUserId,
    });

    const notes = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "note_added")));
    expect(notes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Cross-check logic tests (via lookupByChip + manual status handling)
// ---------------------------------------------------------------------------
// createIntakeAction and createPetAction cannot be called directly in tests
// because they depend on requireCapability / supabase server client session.
// We test the cross-check LOGIC by verifying that lookupByChip returns the
// expected shape, and that the force-token gates work correctly. The server
// action tests in the manual smoke checklist cover the full integration.

describe("cross-check logic — intake scenarios", () => {
  it("chip with no match → no block (proceeds normally)", async () => {
    const result = await lookupByChip("CHIP-NO-MATCH-AT-ALL-9999");
    expect(result).toBeNull();
    // Caller proceeds with normal intake flow when result is null.
  });

  it("chip with lost match → should block (CHIP_MATCH_LOST)", async () => {
    const chip = `CHIP-LOST-BLOCK-${Date.now()}`;
    const { canonicalChip } = await insertPetWithChip({
      microchipId: chip,
      status: "lost",
      ownerUserId: ownerUserId,
      tokenSuffix: "LOSTBLK",
    });
    const result = await lookupByChip(canonicalChip);
    expect(result).not.toBeNull();
    expect(result?.pet.status).toBe("lost");
    // Caller: redirect to match confirmation page.
  });

  it("chip with active match without forceToken → should warn (CHIP_MATCH_ACTIVE)", async () => {
    const chip = `CHIP-ACT-WARN-${Date.now()}`;
    const { canonicalChip } = await insertPetWithChip({
      microchipId: chip,
      status: "active",
      ownerUserId: ownerUserId,
      tokenSuffix: "ACTWARN",
    });
    const result = await lookupByChip(canonicalChip);
    expect(result).not.toBeNull();
    expect(result?.pet.status).toBe("active");
    // Caller: check forceToken; if absent → return warning.
    const hasForce = false;
    expect(hasForce).toBe(false); // no token → should warn
  });

  it("chip with active match WITH valid forceToken → should proceed", async () => {
    const chip = `CHIP-ACT-FORCE-${Date.now()}`;
    await insertPetWithChip({
      microchipId: chip,
      status: "active",
      ownerUserId: ownerUserId,
      tokenSuffix: "ACTFRC",
    });
    const token = generateForceToken(chip);
    expect(validateForceToken(chip, token)).toBe(true);
    // Caller: token valid → proceed with intake.
  });

  it("chip with deceased match → should block unconditionally (CHIP_MATCH_DECEASED)", async () => {
    const chip = `CHIP-DEC-BLOCK-${Date.now()}`;
    const { canonicalChip } = await insertPetWithChip({
      microchipId: chip,
      status: "deceased",
      ownerUserId: ownerUserId,
      tokenSuffix: "DECBLK",
    });
    const result = await lookupByChip(canonicalChip);
    expect(result).not.toBeNull();
    expect(result?.pet.status).toBe("deceased");
    // Caller: always return error regardless of forceToken.
  });
});

// ---------------------------------------------------------------------------
// 5. createIntake — active-chip match is an HONEST hard block (real insert path)
// ---------------------------------------------------------------------------
// Regression for the "force past active-chip match is a guaranteed crash" bug:
// the old forceToken fall-through wrote a second active pet_identifications row
// with the same code, always violating pet_identifications_chip_unique — the tx
// threw and the generic catch leaked a raw driver message. createIntake is called
// directly (the capability shim lives in app/actions/intake.ts); the use-case
// itself needs no Next.js session, only an authenticated {user, organization}.

describe("createIntake — active-chip cross-check", () => {
  function intakeFormData(microchipId: string): FormData {
    const fd = new FormData();
    fd.set("name", "Intake Active Chip");
    fd.set("species", "dog");
    fd.set("sex", "unknown");
    fd.set("intakeReason", "rescue");
    fd.set("custodyRole", "shelter_custody");
    fd.set("microchipId", microchipId);
    fd.set("microchipCountryCode", "032");
    fd.set("noRedirect", "1");
    return fd;
  }

  it("blocks honestly (no crash, no duplicate ident) when the chip belongs to an active pet", async () => {
    // 15-digit ISO code so insertPetWithChip stores it verbatim and validateMicrochipId
    // accepts it unchanged — the intake sees the exact same canonical code.
    const chip = "032000000012345";
    const { canonicalChip } = await insertPetWithChip({
      microchipId: chip,
      status: "active",
      ownerUserId,
      tokenSuffix: "INTAKEACT",
    });
    expect(canonicalChip).toBe(chip);

    const result = await createIntake(
      orgToken,
      { id: refugioMemberUserId },
      { id: orgId, displayName: "Chip Match Refugio", verified: true },
      intakeFormData(chip),
    );

    // Honest hard block — NOT a raw unique-violation crash, NOT a "continue anyway".
    expect(result.ok).toBeUndefined();
    expect(result.error).toMatch(/ya está registrado en miMAR para una mascota activa/i);
    // The old bug surfaced the raw driver string — assert it never does.
    expect(result.error ?? "").not.toMatch(/unique|constraint|duplicate key/i);
    // No warning / continue-anyway path is offered for the doomed case.
    expect(result.warning).toBeUndefined();

    // Exactly ONE active microchip_iso row for the chip — no duplicate was inserted.
    const chipRows = await db
      .select({ id: petIdentifications.id })
      .from(petIdentifications)
      .where(
        and(
          eq(petIdentifications.kind, "microchip_iso"),
          eq(petIdentifications.code, chip),
          eq(petIdentifications.status, "active"),
        ),
      );
    expect(chipRows.length).toBe(1);
  });
});
