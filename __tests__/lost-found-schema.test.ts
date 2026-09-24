// Schema-layer tests for Lost & Found Fase 1.
//
// Split into two describe blocks:
//
//   1. Unit tests (pure Zod — no DB, no Supabase, no network).
//      Covers statusChanged, custodyTransferred, and custodyTransferProposed
//      payload validation including the new optional fields.
//
//   2. Integration tests (Drizzle + local Supabase).
//      Covers the database-level defaults for the 5 disclose_*_when_lost
//      columns on pets and the receives_broadcasts column on
//      organization_memberships.

import { createClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, organizationMemberships, organizations, pets, profiles } from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

// ---------------------------------------------------------------------------
// Unit tests — Zod schemas only
// ---------------------------------------------------------------------------

describe("statusChanged — Zod schema", () => {
  const base = {
    payload_version: 1 as const,
    from_status: "active" as const,
    to_status: "lost" as const,
  };

  it("accepts payload WITHOUT the new optional fields (backwards-compat)", () => {
    expect(() => validateEventPayload("status_changed", base)).not.toThrow();
  });

  it("accepts payload WITH disclosure_prefs_snapshot", () => {
    const payload = {
      ...base,
      disclosure_prefs_snapshot: {
        first_name: true,
        phone: true,
        email: false,
        last_location: true,
        finder_form: true,
      },
    };
    expect(() => validateEventPayload("status_changed", payload)).not.toThrow();
  });

  it("accepts payload WITH lost_description (all 3 sub-fields)", () => {
    const payload = {
      ...base,
      lost_description: {
        accessories_when_lost: "collar negro con chapita roja",
        behavior_notes: "huidiza con extraños",
        last_seen_context: "escapó del jardín por Cerviño",
      },
    };
    expect(() => validateEventPayload("status_changed", payload)).not.toThrow();
  });

  it("accepts payload WITH lost_description = null", () => {
    const payload = { ...base, lost_description: null };
    expect(() => validateEventPayload("status_changed", payload)).not.toThrow();
  });

  it("rejects payload with extra keys (strict)", () => {
    const payload = { ...base, unexpected_key: "oops" };
    expect(() => validateEventPayload("status_changed", payload)).toThrow();
  });
});

// Valid RFC 4122 UUIDs for test fixtures (version 4, variant 1).
const ORG_A_ID = "a0000000-0000-4000-8000-000000000001";
const ORG_B_ID = "b0000000-0000-4000-8000-000000000002";
const USER_C_ID = "c0000000-0000-4000-8000-000000000003";
const USER_D_ID = "d0000000-0000-4000-8000-000000000004";
const PET_E_ID = "e0000000-0000-4000-8000-000000000005";

describe("custodyTransferred — Zod schema", () => {
  const legacyOrgToOrg = {
    payload_version: 1 as const,
    from_organization_id: ORG_A_ID,
    to_organization_id: ORG_B_ID,
    from_role: "shelter_custody" as const,
    to_role: "shelter_custody" as const,
    foster_ended_event_id: null,
    notes: null,
  };

  it("accepts org-to-org payload (legacy shape, backwards-compat)", () => {
    expect(() => validateEventPayload("custody_transferred", legacyOrgToOrg)).not.toThrow();
  });

  it("accepts org-to-user payload (return-to-owner shape)", () => {
    const payload = {
      payload_version: 1 as const,
      from_organization_id: ORG_A_ID,
      to_user_id: USER_C_ID,
      from_role: "shelter_custody" as const,
      to_role: "owner" as const,
      reason: "return_to_original_owner" as const,
      foster_ended_event_id: null,
      notes: "owner recibió a Negrita en el refugio",
    };
    expect(() => validateEventPayload("custody_transferred", payload)).not.toThrow();
  });

  it("rejects payload where BOTH from_user_id AND from_organization_id are set", () => {
    const payload = {
      ...legacyOrgToOrg,
      from_user_id: USER_D_ID,
    };
    expect(() => validateEventPayload("custody_transferred", payload)).toThrow();
  });
});

describe("custodyTransferProposed — Zod schema", () => {
  const validProposal = {
    payload_version: 1 as const,
    from_organization_id: ORG_A_ID,
    from_user_id: null,
    to_user_id: USER_C_ID,
    to_organization_id: null,
    reason: "return_to_original_owner" as const,
    matched_against_pet_id: PET_E_ID,
    proposed_at: "2026-05-17T14:00:00.000Z",
    notes: "Refugio propone devolver a Negrita",
  };

  it("accepts a well-formed proposal payload", () => {
    expect(() => validateEventPayload("custody_transfer_proposed", validProposal)).not.toThrow();
  });

  it("accepts proposal without optional fields (notes, matched_against_pet_id)", () => {
    const { matched_against_pet_id: _m, notes: _n, ...minimal } = validProposal;
    expect(() => validateEventPayload("custody_transfer_proposed", minimal)).not.toThrow();
  });

  it("rejects proposal where BOTH from_user_id AND from_organization_id are non-null", () => {
    const payload = {
      ...validProposal,
      from_user_id: USER_D_ID,
    };
    expect(() => validateEventPayload("custody_transfer_proposed", payload)).toThrow();
  });

  it("rejects proposal where both from_user_id AND from_organization_id are null", () => {
    const payload = { ...validProposal, from_organization_id: null, from_user_id: null };
    expect(() => validateEventPayload("custody_transfer_proposed", payload)).toThrow();
  });

  it("rejects proposal where both to_user_id AND to_organization_id are null", () => {
    const payload = { ...validProposal, to_user_id: null, to_organization_id: null };
    expect(() => validateEventPayload("custody_transfer_proposed", payload)).toThrow();
  });

  it("rejects proposal with extra keys (strict)", () => {
    const payload = { ...validProposal, unexpected_key: "oops" };
    expect(() => validateEventPayload("custody_transfer_proposed", payload)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — DB defaults (requires local Supabase)
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const TEST_EMAIL_OWNER = "lost-found-schema-owner@dim-test.local";
const TEST_EMAIL_ORG_MEMBER = "lost-found-schema-member@dim-test.local";
const TEST_PASS = "LostFound_2026!";

let ownerUserId: string;
let memberUserId: string;
let insertedPetId: string;
let insertedOrgId: string;
let insertedMembershipId: string;

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
  for (const uid of ids) {
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await purgeUserByEmail(TEST_EMAIL_OWNER);
  await purgeUserByEmail(TEST_EMAIL_ORG_MEMBER);

  const o = await createFreshTestUser(supabaseAdmin, {
    email: TEST_EMAIL_OWNER,
    password: TEST_PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;

  const m = await createFreshTestUser(supabaseAdmin, {
    email: TEST_EMAIL_ORG_MEMBER,
    password: TEST_PASS,
    email_confirm: true,
  });
  if (m.error || !m.data.user) throw new Error(`createUser member: ${m.error?.message}`);
  memberUserId = m.data.user.id;
});

afterAll(async () => {
  // Clean up in reverse dependency order.
  if (insertedMembershipId) {
    await db
      .delete(organizationMemberships)
      .where(eq(organizationMemberships.id, insertedMembershipId));
  }
  if (insertedOrgId) {
    await db.delete(organizations).where(eq(organizations.id, insertedOrgId));
  }
  if (insertedPetId) {
    // pets has pet_events cascade; safe to delete directly in tests.
    await db.delete(pets).where(eq(pets.id, insertedPetId));
  }
  await purgeUserByEmail(TEST_EMAIL_OWNER);
  await purgeUserByEmail(TEST_EMAIL_ORG_MEMBER);
});

describe("pets — disclosure preference column defaults", () => {
  // Privacy hardening (cursor privacy P4, migration 0158): the three
  // PII-disclosing columns now DEFAULT false, matching MarkLostWizard's
  // affirmative-consent defaults (DISCLOSURE_DEFAULTS) — a row inserted
  // without explicit values must land closed, not the old permissive
  // Tier 1 reveal. allow_finder_form_when_lost stays true (no owner PII).
  it("new pet row gets correct defaults for all 5 disclose_* columns", async () => {
    const [row] = await db
      .insert(pets)
      .values({
        publicToken: `DIM-LF1-${Date.now().toString(36).toUpperCase().slice(-6)}`,
        name: "DefaultsTestPet",
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();

    insertedPetId = row.id;

    expect(row.discloseFirstNameWhenLost).toBe(false);
    expect(row.disclosePhoneWhenLost).toBe(false);
    expect(row.discloseEmailWhenLost).toBe(false);
    expect(row.discloseLastLocationWhenLost).toBe(false);
    expect(row.allowFinderFormWhenLost).toBe(true);
  });
});

describe("organization_memberships — receivesBroadcasts default", () => {
  it("new membership gets receivesBroadcasts=true by default", async () => {
    // Create a minimal organization first.
    const [org] = await db
      .insert(organizations)
      .values({
        publicToken: `DIM-ORG-LF1-${Date.now().toString(36).toUpperCase().slice(-6)}`,
        legalName: "LF1 Test Org SRL",
        displayName: "LF1 Test Org",
        orgType: "shelter",
        email: "lf1-test-org@dim-test.local",
        jurisdictionCountry: "AR",
      })
      .returning();
    insertedOrgId = org.id;

    const [membership] = await db
      .insert(organizationMemberships)
      .values({
        organizationId: org.id,
        userId: memberUserId,
        role: "member",
        canWritePetEvents: false,
      })
      .returning();
    insertedMembershipId = membership.id;

    expect(membership.receivesBroadcasts).toBe(true);
  });
});
