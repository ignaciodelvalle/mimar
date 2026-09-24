// Integration tests for Lost & Found Fase 5 — return-to-owner two-phase
// handshake + lazy auto-cancel.
//
// Structure:
//   1. proposeReturnToOwnerAction — refugio + vecino happy paths + rejections
//   2. ownerAcceptReturnAction — happy path + auto-cancel scenarios
//   3. ownerRejectReturnAction — note event + notification
//   4. actorCancelProposalAction — cancellation event + notification to owner
//
// Database setup mirrors chip-match.test.ts (ephemeral users + transaction tests).
// All rows created here are deleted in afterAll.

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { generatePublicToken } from "@/lib/infra/publicToken";
import {
  actorCancelProposalWriter,
  orgAcceptOwnerReturnWriter,
  orgRejectOwnerReturnWriter,
  ownerAcceptReturnWriter,
  ownerProposeReturnToOrgWriter,
  ownerRejectReturnWriter,
  proposeReturnAsRefugioWriter,
  proposeReturnAsVecinoWriter,
} from "@/src/modules/return-to-owner/application/writers";
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

const OWNER_EMAIL = "return-owner@dim-test.local";
const REFUGIO_MEMBER_EMAIL = "return-refugio-member@dim-test.local";
const VECINO_EMAIL = "return-vecino@dim-test.local";
const PASS = "ReturnTest_2026!";

let ownerUserId: string;
let refugioMemberUserId: string;
let vecinoUserId: string;
let orgId: string;
let orgToken: string;

// Pet IDs tracked for cleanup.
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
  if (m.error || !m.data.user) throw new Error(`createUser refugio member: ${m.error?.message}`);
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
      legalName: "Return Test Refugio SRL",
      displayName: "Return Test Refugio",
      orgType: "shelter",
      email: "return-refugio@dim-test.local",
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

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }

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
// Helper: insert a lost pet with an owner + optional shelter_custody
// ---------------------------------------------------------------------------

async function insertLostPet(opts: {
  ownerUserId: string;
  status?: "active" | "lost" | "deceased";
  shelterCustodyOrgId?: string;
  shelterCustodyUserId?: string;
  tokenSuffix?: string;
}): Promise<{ petId: string; publicToken: string }> {
  const suffix = opts.tokenSuffix ?? Date.now().toString(36).toUpperCase().slice(-6);
  const token = `RTN-${suffix}`;
  const now = new Date();

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `ReturnPet-${suffix}`,
      species: "dog",
      sex: "unknown",
      status: opts.status ?? "lost",
      potentiallyDangerousBreed: false,
    })
    .returning();

  insertedPetIds.push(pet.id);

  // Insert owner ownership.
  await db.insert(ownerships).values({
    petId: pet.id,
    ownerUserId: opts.ownerUserId,
    role: "owner",
    startedAt: now,
  });

  // Insert shelter_custody if requested.
  if (opts.shelterCustodyOrgId) {
    await db.insert(ownerships).values({
      petId: pet.id,
      ownerOrganizationId: opts.shelterCustodyOrgId,
      role: "shelter_custody",
      startedAt: now,
    });
  }
  if (opts.shelterCustodyUserId) {
    await db.insert(ownerships).values({
      petId: pet.id,
      ownerUserId: opts.shelterCustodyUserId,
      role: "shelter_custody",
      startedAt: now,
    });
  }

  return { petId: pet.id, publicToken: token };
}

// ---------------------------------------------------------------------------
// 1. proposeReturnToOwnerAction — refugio
// ---------------------------------------------------------------------------

describe("proposeReturnAsRefugioWriter", () => {
  it("happy path: emits custody_transfer_proposed and notifies owner", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    const result = await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: "Listo para la entrega.",
    });

    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result)) throw new Error("Expected ok");
    expect(result.eventId).toBeTruthy();

    // Verify event was created.
    const events = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")));
    expect(events.length).toBe(1);

    // Verify the event payload shape.
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.reason).toBe("return_to_original_owner");
    expect(payload.from_organization_id).toBe(orgId);
    expect(payload.to_user_id).toBe(ownerUserId);
    expect(payload.notes).toBe("Listo para la entrega.");

    // Verify owner notification.
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "custody_transfer_proposal_owner"),
          eq(notifications.relatedPetId, petId),
        ),
      );
    expect(notifs.length).toBeGreaterThan(0);
    expect(notifs[0].severity).toBe("urgent");
  });

  it("rejects when pet is not lost", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      status: "active",
      shelterCustodyOrgId: orgId,
    });

    const result = await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/perdida/i);
  });

  it("rejects when org has no active shelter_custody", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      // No shelter custody inserted
    });

    const result = await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/custodia/i);
  });

  it("rejects when a pending proposal already exists (anti-double-proposal)", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    // First proposal — should succeed.
    const first = await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });
    expect("ok" in first && first.ok).toBe(true);

    // Second proposal from same actor — should be blocked.
    const second = await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    expect("error" in second).toBe(true);
    if (!("error" in second)) throw new Error("Expected error");
    expect(second.error).toMatch(/pendiente/i);
  });
});

// ---------------------------------------------------------------------------
// 2. proposeReturnAsVecinoWriter
// ---------------------------------------------------------------------------

describe("proposeReturnAsVecinoWriter", () => {
  it("happy path: emits proposal and notifies owner", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    const result = await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: "Vecino quiere devolver.",
    });

    expect("ok" in result && result.ok).toBe(true);

    const events = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")));
    expect(events.length).toBe(1);

    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.from_user_id).toBe(vecinoUserId);
    expect(payload.to_user_id).toBe(ownerUserId);

    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "custody_transfer_proposal_owner"),
          eq(notifications.relatedPetId, petId),
        ),
      );
    expect(notifs.length).toBeGreaterThan(0);
  });

  it("rejects when vecino has no shelter_custody", async () => {
    const { publicToken } = await insertLostPet({ ownerUserId });

    const result = await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/custodia/i);
  });
});

// ---------------------------------------------------------------------------
// 3. ownerAcceptReturnWriter — happy path
// ---------------------------------------------------------------------------

describe("ownerAcceptReturnWriter — happy path", () => {
  it("executes transfer, ends shelter_custody, flips pet to active", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    // Propose first.
    const propose = await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });
    expect("ok" in propose && propose.ok).toBe(true);

    // Owner accepts.
    const result = await ownerAcceptReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.ok).toBe(true);
    if ("autoCancelled" in result && result.autoCancelled) {
      throw new Error(`Unexpected autoCancelled: ${result.reason}`);
    }

    // Verify custody_transferred event.
    const transferEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")));
    expect(transferEvents.length).toBe(1);

    const tPayload = transferEvents[0].payload as Record<string, unknown>;
    expect(tPayload.reason).toBe("return_to_original_owner");
    expect(tPayload.to_user_id).toBe(ownerUserId);

    // Verify shelter_custody was ended.
    const activeCustody = await db
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
    expect(activeCustody.length).toBe(0);

    // Verify pet status flipped to active.
    const [updatedPet] = await db
      .select({ status: pets.status })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(updatedPet.status).toBe("active");

    // Verify status_changed event was emitted.
    const statusEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "status_changed")));
    expect(statusEvents.length).toBeGreaterThan(0);
    const lastStatus = statusEvents[statusEvents.length - 1].payload as Record<string, unknown>;
    expect(lastStatus.from_status).toBe("lost");
    expect(lastStatus.to_status).toBe("active");

    // Verify actor notification.
    const actorNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, refugioMemberUserId),
          eq(notifications.notificationType, "custody_transfer_accepted_owner_side"),
          eq(notifications.relatedPetId, petId),
        ),
      );
    expect(actorNotifs.length).toBeGreaterThan(0);
  });

  it("vecino happy path: transfer completes, shelter_custody ended, pet active", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    const propose = await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });
    expect("ok" in propose && propose.ok).toBe(true);

    const result = await ownerAcceptReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);

    // shelter_custody of vecino ended.
    const activeCustody = await db
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
    expect(activeCustody.length).toBe(0);

    const [updatedPet] = await db
      .select({ status: pets.status })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(updatedPet.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// 4. ownerAcceptReturnWriter — auto-cancel scenarios
// ---------------------------------------------------------------------------

describe("ownerAcceptReturnWriter — auto-cancel", () => {
  it("auto-cancels when pet is already active (found by owner independently)", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      status: "active", // already found — simulate post-hoc
      shelterCustodyOrgId: orgId,
    });

    // Insert proposal event directly (bypassing the lost-status check in propose).
    const now = new Date();
    await withMutationOverride(async (tx) => {
      const { validateEventPayload } = await import("@/lib/events/event-schemas");
      const payload = validateEventPayload("custody_transfer_proposed", {
        from_user_id: null,
        from_organization_id: orgId,
        to_user_id: ownerUserId,
        to_organization_id: null,
        reason: "return_to_original_owner",
        notes: null,
        matched_against_pet_id: petId,
        proposed_at: now.toISOString(),
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transfer_proposed",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: refugioMemberUserId,
        authorRole: "shelter",
        authorOrganizationId: orgId,
        payload,
      });
    });

    // Owner tries to accept — but pet is no longer lost.
    const result = await ownerAcceptReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect("autoCancelled" in result && result.autoCancelled).toBe(true);

    // Verify auto-cancel emitted custody_transfer_cancelled (ARCH-B).
    const cancelEvents = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(cancelEvents.length).toBeGreaterThan(0);
    const cancelPayload = cancelEvents[cancelEvents.length - 1].payload as Record<string, unknown>;
    expect(cancelPayload.cancelled_by).toBe("auto_cancel");
    expect(typeof cancelPayload.proposal_event_id).toBe("string");
  });

  it("auto-cancels when shelter_custody was revoked between propose and accept", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    // Propose.
    await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    // Revoke the org's shelter_custody BEFORE the owner accepts.
    await db
      .update(ownerships)
      .set({ endedAt: new Date() })
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, orgId),
          eq(ownerships.role, "shelter_custody"),
          isNull(ownerships.endedAt),
        ),
      );

    // Owner accepts — but custody is gone.
    const result = await ownerAcceptReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect("autoCancelled" in result && result.autoCancelled).toBe(true);
    if (!("autoCancelled" in result)) throw new Error("Expected autoCancelled");
    expect(result.reason).toMatch(/custodia/i);
  });

  it("returns error when no pending proposal exists", async () => {
    const { publicToken } = await insertLostPet({ ownerUserId });

    const result = await ownerAcceptReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/propuesta/i);
  });

  it("returns error when caller is not the owner", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    // Propose as refugio.
    await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    // Try to accept as vecino (not the owner).
    const result = await ownerAcceptReturnWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
    });

    expect("error" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. ownerRejectReturnWriter
// ---------------------------------------------------------------------------

describe("ownerRejectReturnWriter", () => {
  it("emits custody_transfer_cancelled, does not change pet status, notifies actor", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    // Propose as vecino.
    await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });

    // Owner rejects.
    const result = await ownerRejectReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
      reason: "Coordinamos por otro medio.",
    });

    expect("ok" in result && result.ok).toBe(true);

    // Verify custody_transfer_cancelled emitted with correct payload (ARCH-B).
    const cancelEvents = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(cancelEvents.length).toBeGreaterThan(0);
    const cancelPayload = cancelEvents[cancelEvents.length - 1].payload as Record<string, unknown>;
    expect(cancelPayload.cancelled_by).toBe("owner_reject");
    expect(cancelPayload.reason).toBe("Coordinamos por otro medio.");
    expect(typeof cancelPayload.proposal_event_id).toBe("string");

    // Verify pet status unchanged (still lost).
    const [currentPet] = await db
      .select({ status: pets.status })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(currentPet.status).toBe("lost");

    // Verify actor (vecino) was notified.
    const actorNotifs = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, vecinoUserId), eq(notifications.relatedPetId, petId)));
    // Should have at least the proposal notification + rejection notification.
    expect(actorNotifs.length).toBeGreaterThan(0);
  });

  it("hasPendingProposal resolves false after rejection (no duplicate proposals allowed)", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });

    await ownerRejectReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
      reason: "No quiero.",
    });

    // A second proposal must succeed (meaning hasPendingProposal returned false after rejection).
    const second = await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });
    expect("ok" in second && second.ok).toBe(true);
  });

  it("returns error when caller is not the owner", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    // Vecino tries to reject.
    const result = await ownerRejectReturnWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      reason: "No es el dueño",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/dueño/i);
  });
});

// ---------------------------------------------------------------------------
// 6. actorCancelProposalWriter
// ---------------------------------------------------------------------------

describe("actorCancelProposalWriter", () => {
  it("vecino cancels own proposal: emits custody_transfer_cancelled, notifies owner", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });

    const result = await actorCancelProposalWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      reason: "Ya no puedo entregarlo hoy.",
    });

    expect("ok" in result && result.ok).toBe(true);

    // Verify custody_transfer_cancelled emitted with correct payload (ARCH-B).
    const cancelEvents = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(cancelEvents.length).toBeGreaterThan(0);
    const cancelPayload = cancelEvents[cancelEvents.length - 1].payload as Record<string, unknown>;
    expect(cancelPayload.cancelled_by).toBe("actor_cancel");
    expect(cancelPayload.reason).toBe("Ya no puedo entregarlo hoy.");
    expect(typeof cancelPayload.proposal_event_id).toBe("string");

    // Verify owner was notified.
    const ownerCancelNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "custody_transfer_auto_cancelled"),
          eq(notifications.relatedPetId, petId),
        ),
      );
    expect(ownerCancelNotifs.length).toBeGreaterThan(0);
  });

  it("refugio org actor cancels own proposal: custody_transfer_cancelled emitted, owner notified", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    const result = await actorCancelProposalWriter({
      userId: refugioMemberUserId,
      petPublicToken: publicToken,
      reason: "El dueño ya coordinó por teléfono.",
      actorOrgId: orgId,
    });

    expect("ok" in result && result.ok).toBe(true);

    // Verify structured cancellation event (ARCH-B).
    const cancelEvents = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(cancelEvents.length).toBeGreaterThan(0);
    const cancelPayload = cancelEvents[cancelEvents.length - 1].payload as Record<string, unknown>;
    expect(cancelPayload.cancelled_by).toBe("actor_cancel");

    // Owner notified.
    const ownerNotifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "custody_transfer_auto_cancelled"),
          eq(notifications.relatedPetId, petId),
        ),
      );
    expect(ownerNotifs.length).toBeGreaterThan(0);
  });

  it("forgery: owner-authored note_added with proposal marker does NOT cancel a NEW proposal", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    // Propose as refugio.
    const propose = await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });
    expect("ok" in propose && propose.ok).toBe(true);
    if (!("ok" in propose)) throw new Error("Expected ok");

    // Fetch the real proposal event id.
    const [proposalEvent] = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);
    expect(proposalEvent).toBeDefined();

    // Craft a forged owner-authored note using the legacy marker pattern.
    await withMutationOverride(async (tx) => {
      const forgedPayload = validateEventPayload("note_added", {
        category: null,
        text: `Proposal event_id=${proposalEvent.id}`,
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "note_added",
        occurredAt: new Date(),
        recordedAt: new Date(),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        payload: forgedPayload,
      });
    });

    // The proposal must still be detected as pending (forged note ignored).
    // A second propose attempt must be blocked.
    const second = await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });
    expect("error" in second).toBe(true);
    if (!("error" in second)) throw new Error("Expected error");
    expect(second.error).toMatch(/pendiente/i);
  });

  it("returns error when caller is not the actor who proposed", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    await proposeReturnAsRefugioWriter({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "Return Test Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    // Vecino tries to cancel a refugio's proposal.
    const result = await actorCancelProposalWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      reason: "Trying to steal the cancel.",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/propuso/i);
  });

  it("returns error when no pending proposal exists", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    const result = await actorCancelProposalWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      reason: "No proposal exists.",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/propuesta/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Fix B — reject/cancel after accept must NOT emit a spurious cancellation
// ---------------------------------------------------------------------------
//
// Under the advisory lock, ownerRejectReturnWriter / actorCancelProposalWriter
// re-verify hasPendingProposal inside the tx. Once the owner has accepted the
// return (custody_transferred emitted), the proposal is resolved, so a late
// reject/cancel must be a no-op: error returned, no custody_transfer_cancelled
// written to the immutable log.

describe("Fix B — reject/cancel after accept does not forge a cancellation", () => {
  it("ownerRejectReturnWriter is a no-op when the proposal was already accepted", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    // Propose then accept — proposal becomes resolved (custody_transferred).
    await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });
    const accept = await ownerAcceptReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });
    expect("error" in accept).toBe(false);

    // No cancellation should exist after a clean accept.
    const before = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(before.length).toBe(0);

    // Late reject — must be rejected by the in-tx hasPendingProposal re-check.
    const reject = await ownerRejectReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
      reason: "Cambié de opinión tarde.",
    });
    expect("error" in reject).toBe(true);
    if (!("error" in reject)) throw new Error("Expected error");
    expect(reject.error).toMatch(/propuesta/i);

    // CRITICAL: no spurious custody_transfer_cancelled emitted into the log.
    const after = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(after.length).toBe(0);
  });

  it("actorCancelProposalWriter is a no-op when the proposal was already accepted", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    await proposeReturnAsVecinoWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });
    const accept = await ownerAcceptReturnWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });
    expect("error" in accept).toBe(false);

    // Late cancel by the actor who proposed — must be a no-op.
    const cancel = await actorCancelProposalWriter({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      reason: "Ya no hace falta.",
    });
    expect("error" in cancel).toBe(true);
    if (!("error" in cancel)) throw new Error("Expected error");
    expect(cancel.error).toMatch(/propuesta/i);

    const cancelEvents = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(cancelEvents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Fix C — org accept/reject events attributed to the acting org member
// ---------------------------------------------------------------------------
//
// Owner proposes a return to the org (from_user_id=owner, to_organization_id=org).
// When the org member accepts/rejects, the emitted pet_events must carry
// recordedByUserId = the acting org member, NOT the owner who proposed.

describe("Fix C — org accept/reject attribution", () => {
  // Inserts a pet adopted from the org: active owner row + a historical
  // adoption_finalized event so ownerProposeReturnToOrgWriter resolves the
  // target org WITHOUT an active shelter_custody row. This mirrors the real
  // post-adoption return flow (the org's custody was ended at adoption), so
  // the org-accept writer can cleanly open a fresh shelter_custody row.
  async function insertAdoptedPetFromOrg(): Promise<{ petId: string; publicToken: string }> {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
      .toUpperCase()
      .slice(-6);
    const token = `RTO-${suffix}`;
    const now = new Date();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `OrgReturnPet-${suffix}`,
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();
    insertedPetIds.push(pet.id);

    await db.insert(ownerships).values({
      petId: pet.id,
      ownerUserId,
      role: "owner",
      startedAt: now,
    });

    // Historical adoption event — resolves the originating org for the return.
    const adoptionPayload = validateEventPayload("adoption_finalized", {
      previous_owner_organization_id: orgId,
      adopter_user_id: ownerUserId,
      foster_user_id: null,
      contract_attachment_id: null,
      post_adoption_followup_months: null,
      notes: null,
    });
    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "adoption_finalized",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: refugioMemberUserId,
      authorRole: "shelter",
      authorOrganizationId: orgId,
      payload: adoptionPayload,
    });

    return { petId: pet.id, publicToken: token };
  }

  it("orgAcceptOwnerReturnWriter attributes custody_transferred to the acting org member, not the proposing owner", async () => {
    const { petId, publicToken } = await insertAdoptedPetFromOrg();

    // Owner proposes the return to the org.
    const propose = await ownerProposeReturnToOrgWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
      reason: "post_adoption_failed_return",
      notes: null,
      proposedAt: new Date().toISOString(),
      callerRole: "owner",
    });
    expect("ok" in propose && propose.ok).toBe(true);
    if ("error" in propose) throw new Error(`Unexpected propose error: ${propose.error}`);

    // Org member accepts.
    const accept = await orgAcceptOwnerReturnWriter({
      orgId,
      orgDisplayName: "Return Test Refugio",
      actingUserId: refugioMemberUserId,
      petPublicToken: publicToken,
    });
    if ("error" in accept) throw new Error(`Unexpected error: ${accept.error}`);
    expect("error" in accept).toBe(false);

    const [transferEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")))
      .orderBy(desc(petEvents.recordedAt))
      .limit(1);
    expect(transferEvent).toBeDefined();
    // Attribution is the acting org member, NOT the owner who proposed.
    expect(transferEvent.recordedByUserId).toBe(refugioMemberUserId);
    expect(transferEvent.recordedByUserId).not.toBe(ownerUserId);
    // Org context unchanged.
    expect(transferEvent.authorRole).toBe("shelter");
    expect(transferEvent.authorOrganizationId).toBe(orgId);
  });

  it("orgRejectOwnerReturnWriter attributes custody_transfer_cancelled to the acting org member, not the proposing owner", async () => {
    const { petId, publicToken } = await insertAdoptedPetFromOrg();

    const propose = await ownerProposeReturnToOrgWriter({
      userId: ownerUserId,
      petPublicToken: publicToken,
      reason: "post_adoption_failed_return",
      notes: null,
      proposedAt: new Date().toISOString(),
      callerRole: "owner",
    });
    expect("ok" in propose && propose.ok).toBe(true);

    const reject = await orgRejectOwnerReturnWriter({
      orgId,
      orgDisplayName: "Return Test Refugio",
      actingUserId: refugioMemberUserId,
      petPublicToken: publicToken,
      reason: "No podemos recibirla ahora.",
    });
    expect("error" in reject).toBe(false);
    if ("error" in reject) throw new Error(`Unexpected error: ${reject.error}`);

    const [cancelEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")))
      .orderBy(desc(petEvents.recordedAt))
      .limit(1);
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent.recordedByUserId).toBe(refugioMemberUserId);
    expect(cancelEvent.recordedByUserId).not.toBe(ownerUserId);
    expect(cancelEvent.authorRole).toBe("shelter");
    expect(cancelEvent.authorOrganizationId).toBe(orgId);
  });
});
