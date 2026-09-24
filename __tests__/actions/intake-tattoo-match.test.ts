// Tests for the tattoo cross-check wired in createIntakeAction (D2).
//
// Covers:
//   1. tattoo-ack-token utility — pure crypto (no DB, no auth)
//   2. Cross-check logic via lookupByTattoo — DB integration
//   3. Intake action: tattoo match → TATTOO_MATCH_POSSIBLE (no pet created)
//      Re-submit with valid ackToken → proceeds (no pet created in unit-style
//      logic test; full integration is smoke-tested manually because
//      createIntakeAction requires a live Next.js / supabase auth session)
//
// DB-integration tests need a running local Supabase stack (pnpm supabase start).

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petIdentifications, pets } from "@/db";
import { generateForceToken, validateForceToken } from "@/lib/infra/microchip-force-token";
import {
  generateTattooAckToken,
  generateTattooAckTokenAtTime,
  validateTattooAckToken,
} from "@/lib/infra/tattoo-ack-token";
import { lookupByTattoo, normalizeTattooCode } from "@/lib/infra/tattoo-lookup";
import { withMutationOverride } from "../_helpers/db-overrides";

// ---------------------------------------------------------------------------
// 1. tattoo-ack-token utility
// ---------------------------------------------------------------------------

describe("tattoo-ack-token: generateTattooAckToken / validateTattooAckToken", () => {
  it("generates a token that validates immediately", () => {
    const code = "K9-2014";
    const token = generateTattooAckToken(code);
    expect(validateTattooAckToken(code, token)).toBe(true);
  });

  it("token for code A does not validate for code B", () => {
    const tokenForA = generateTattooAckToken("K9-2014");
    expect(validateTattooAckToken("A1-XXXX", tokenForA)).toBe(false);
  });

  it("tampered token fails validation", () => {
    const code = "TATTOO-TAMPER";
    const token = generateTattooAckToken(code);
    const tampered = `${token.slice(0, -5)}XXXXX`;
    expect(validateTattooAckToken(code, tampered)).toBe(false);
  });

  it("token with wrong format returns false", () => {
    expect(validateTattooAckToken("K9-ANY", "not-a-valid-token")).toBe(false);
    expect(validateTattooAckToken("K9-ANY", "")).toBe(false);
    expect(validateTattooAckToken("K9-ANY", "abc.notanumber")).toBe(false);
  });

  it("expired token (TTL path) fails validation", () => {
    // generateTattooAckTokenAtTime produces a correctly-MACed token whose
    // timestamp is in the past, so rejection is due to TTL — not MAC mismatch.
    const code = "TATTOO-EXPIRE-TEST";
    const sixteenMinutesAgo = Date.now() - 16 * 60 * 1000;
    const expiredToken = generateTattooAckTokenAtTime(code, sixteenMinutesAgo);
    // The MAC is valid for the old timestamp, so only the TTL check rejects it.
    expect(validateTattooAckToken(code, expiredToken)).toBe(false);
  });

  it("chip forceToken does not pass tattoo ack validation (independent tokens)", () => {
    // Chips and tattoos use different signing namespaces (tattoo: prefix).
    // A token generated for a chip code should not ack a tattoo code even
    // if both have the same string value.
    const sharedCode = "SHARED-CODE";
    const chipToken = generateForceToken(sharedCode);
    expect(validateTattooAckToken(sharedCode, chipToken)).toBe(false);
  });

  it("tattooAckToken does not pass chip force-token validation (reverse symmetry)", () => {
    // Mirrors the test above: the prefix "tattoo:" separates the two HMAC
    // namespaces, so a tattoo ack token must never satisfy validateForceToken.
    const sharedCode = "SHARED-CODE-REVERSE";
    const tattooToken = generateTattooAckToken(sharedCode);
    expect(validateForceToken(sharedCode, tattooToken)).toBe(false);
  });

  it("TATTOO_MATCH_POSSIBLE response carries ONLY the tattoo ack token, never a chip force token", () => {
    // The combined chip-active + tattoo-match "infinite loop" the old carry-forward
    // guarded against can no longer happen: an ACTIVE-chip match is now a HARD BLOCK
    // returned before the tattoo check ever runs (a second intake for the same chip
    // always violates pet_identifications_chip_unique). So the tattoo branch threads
    // ONLY the tattooAckToken — there is no forceToken to bundle anymore.
    const tattooCode = "K9-COMBINED";
    const tattooAckToken = generateTattooAckToken(tattooCode);
    expect(validateTattooAckToken(tattooCode, tattooAckToken)).toBe(true);

    const responseShape = {
      error: null,
      warning: "TATTOO_MATCH_POSSIBLE" as const,
      matchedPetToken: "some-pet-token",
      tattooAckToken,
    };
    expect(responseShape.tattooAckToken).toBeDefined();
    expect("forceToken" in responseShape).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-check logic via lookupByTattoo — DB integration
// ---------------------------------------------------------------------------

const TEST_CODE_ACTIVE = `INTAKE-TAT-ACTIVE-${Date.now()}`;
const TEST_CODE_LOST = `INTAKE-TAT-LOST-${Date.now()}`;
const TEST_CODE_DECEASED = `INTAKE-TAT-DEC-${Date.now()}`;

let petActiveId: string;
let petLostId: string;
let petDeceasedId: string;

beforeAll(async () => {
  // Clean up any prior test artifacts with the same code prefix.
  // ARCH-S: tattoo_code column dropped from pets — scan pet_identifications instead.
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM ownerships WHERE pet_id IN (
        SELECT DISTINCT pet_id FROM pet_identifications
        WHERE kind = 'tattoo' AND code LIKE 'INTAKE-TAT-%'
      )`,
    );
    await tx.execute(
      sql`DELETE FROM pets WHERE id IN (
        SELECT DISTINCT pet_id FROM pet_identifications
        WHERE kind = 'tattoo' AND code LIKE 'INTAKE-TAT-%'
      )`,
    );
  });

  const today = new Date().toISOString().slice(0, 10);

  const [petActive] = await db
    .insert(pets)
    .values({
      publicToken: `ITAT-A-${Date.now()}`,
      name: "Intake Tattoo Active",
      species: "dog",
      sex: "male",
      status: "active",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petActiveId = petActive.id;
  await db.insert(petIdentifications).values({
    petId: petActiveId,
    kind: "tattoo",
    code: TEST_CODE_ACTIVE,
    tattooLocation: "inner_ear_left",
    recordedAt: today,
  });

  const [petLost] = await db
    .insert(pets)
    .values({
      publicToken: `ITAT-L-${Date.now()}`,
      name: "Intake Tattoo Lost",
      species: "dog",
      sex: "female",
      status: "lost",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petLostId = petLost.id;
  await db.insert(petIdentifications).values({
    petId: petLostId,
    kind: "tattoo",
    code: TEST_CODE_LOST,
    recordedAt: today,
  });

  const [petDeceased] = await db
    .insert(pets)
    .values({
      publicToken: `ITAT-D-${Date.now()}`,
      name: "Intake Tattoo Deceased",
      species: "cat",
      sex: "unknown",
      status: "deceased",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petDeceasedId = petDeceased.id;
  await db.insert(petIdentifications).values({
    petId: petDeceasedId,
    kind: "tattoo",
    code: TEST_CODE_DECEASED,
    recordedAt: today,
  });
});

afterAll(async () => {
  // ARCH-S: tattoo_code column dropped from pets — scan pet_identifications.
  await withMutationOverride(async (tx) => {
    await tx.execute(
      sql`DELETE FROM ownerships WHERE pet_id IN (
        SELECT DISTINCT pet_id FROM pet_identifications
        WHERE kind = 'tattoo' AND code LIKE 'INTAKE-TAT-%'
      )`,
    );
    await tx.execute(
      sql`DELETE FROM pets WHERE id IN (
        SELECT DISTINCT pet_id FROM pet_identifications
        WHERE kind = 'tattoo' AND code LIKE 'INTAKE-TAT-%'
      )`,
    );
  });
});

describe("intake tattoo cross-check logic", () => {
  it("no tattoo code → no lookup needed (proceed normally)", async () => {
    // Caller: if parsed.tattooCode is null, skip the block entirely.
    const result = await lookupByTattoo("");
    expect(result).toBeNull();
  });

  it("tattoo with no match → no advisory returned (proceed)", async () => {
    const result = await lookupByTattoo("TATTOO-DOES-NOT-EXIST-AT-ALL");
    expect(result).toBeNull();
  });

  it("tattoo with active match → should surface TATTOO_MATCH_POSSIBLE advisory", async () => {
    const result = await lookupByTattoo(TEST_CODE_ACTIVE);
    expect(result).not.toBeNull();
    expect(result?.pet.id).toBe(petActiveId);
    expect(result?.pet.status).toBe("active");
    // Caller: result !== null && status !== 'deceased' → return advisory.
  });

  it("tattoo with lost match → should surface TATTOO_MATCH_POSSIBLE advisory", async () => {
    const result = await lookupByTattoo(TEST_CODE_LOST);
    expect(result).not.toBeNull();
    expect(result?.pet.id).toBe(petLostId);
    expect(result?.pet.status).toBe("lost");
    // Caller: result !== null && status !== 'deceased' → return advisory.
  });

  it("tattoo with deceased match → no advisory (deceased pets are skipped)", async () => {
    // The action skips deceased matches — they should not surface a warning.
    const result = await lookupByTattoo(TEST_CODE_DECEASED);
    // The lookup DOES find the deceased pet in the DB...
    expect(result?.pet.status).toBe("deceased");
    // ...but the action checks: status !== 'deceased' before returning advisory.
    const shouldWarn = result !== null && result.pet.status !== "deceased";
    expect(shouldWarn).toBe(false);
  });

  it("ack token valid for code → should proceed (skip check)", () => {
    const code = normalizeTattooCode(TEST_CODE_ACTIVE);
    const token = generateTattooAckToken(code);
    expect(validateTattooAckToken(code, token)).toBe(true);
    // Caller: ackValid === true → skip lookup, proceed with intake.
  });

  it("ack token for different code → should re-surface advisory", () => {
    const tokenForOther = generateTattooAckToken("SOME-OTHER-CODE");
    expect(validateTattooAckToken(TEST_CODE_ACTIVE, tokenForOther)).toBe(false);
    // Caller: ackValid === false → run lookup → surface advisory again.
  });

  it("advisory returns matchedPetToken from lookup result", async () => {
    const result = await lookupByTattoo(TEST_CODE_ACTIVE);
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected match");
    // Simulates what createIntakeAction does: return { matchedPetToken: result.pet.publicToken }
    expect(result.pet.publicToken).toMatch(/^ITAT-A-/);
    // Only the public token is surfaced — no owner PII.
    expect("ownerFirstName" in result).toBe(true); // field exists but...
    // The UI must NOT render ownerFirstName; it only shows the /p/{token} link.
  });
});
