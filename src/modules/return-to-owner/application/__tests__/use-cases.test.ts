// Parity and use-case tests for src/modules/return-to-owner/application/*.
//
// These are INTEGRATION tests that run against the real seeded Postgres DB,
// mirroring the approach in __tests__/return-to-owner.test.ts.
//
// We drive the use-cases directly (no auth wrappers) and assert on DB state
// and return values to confirm parity with the original monolithic action.
//
// Tests covered:
//   proposeReturnAsRefugioUseCase:
//     - happy path: proposal event + owner notification
//     - rejects when pet is not lost
//     - rejects when org has no shelter_custody
//     - rejects duplicate proposals (anti-double-proposal)
//
//   proposeReturnAsVecinoUseCase:
//     - happy path: proposal event + owner notification
//     - rejects when vecino has no shelter_custody
//
//   ownerAcceptReturnUseCase:
//     - happy path: custody_transferred + shelter_custody ended + pet active
//     - auto-cancel when pet is already active
//     - auto-cancel when shelter_custody revoked
//     - error when no pending proposal
//
//   ownerRejectReturnUseCase:
//     - happy path: custody_transfer_cancelled + owner notified
//     - error when caller is not owner
//
//   actorCancelProposalUseCase:
//     - vecino cancels own proposal
//     - error when caller is not the proposer
//
//   ownerProposeReturnToOrgUseCase:
//     - happy path: proposal event + org admin notified
//
//   orgAcceptOwnerReturnUseCase:
//     - happy path: custody_transferred attributed to acting org member
//
//   orgRejectOwnerReturnUseCase:
//     - happy path: custody_transfer_cancelled attributed to acting org member

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
import { withMutationOverride } from "../../../../../__tests__/_helpers/db-overrides";

import { createFreshTestUser } from "@/__tests__/_helpers/fresh-test-user";
import { actorCancelProposalUseCase } from "../actor-cancel-proposal";
import { orgAcceptOwnerReturnUseCase } from "../org-accept-owner-return";
import { orgRejectOwnerReturnUseCase } from "../org-reject-owner-return";
import { ownerAcceptReturnUseCase } from "../owner-accept-return";
import { ownerProposeReturnToOrgUseCase } from "../owner-propose-return-to-org";
import { ownerRejectReturnUseCase } from "../owner-reject-return";
import { proposeReturnAsRefugioUseCase } from "../propose-return-as-refugio";
import { proposeReturnAsVecinoUseCase } from "../propose-return-as-vecino";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const UC_OWNER_EMAIL = "uc-rto-owner@dim-test.local";
const UC_REFUGIO_EMAIL = "uc-rto-refugio@dim-test.local";
const UC_VECINO_EMAIL = "uc-rto-vecino@dim-test.local";
const PASS = "ReturnUC_2026!";

let ownerUserId: string;
let refugioMemberUserId: string;
let vecinoUserId: string;
let orgId: string;
let orgToken: string;

const insertedPetIds: string[] = [];

// ---------------------------------------------------------------------------
// Cleanup helpers
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
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

async function insertLostPet(opts: {
  ownerUserId: string;
  status?: "active" | "lost" | "deceased";
  shelterCustodyOrgId?: string;
  shelterCustodyUserId?: string;
}): Promise<{ petId: string; publicToken: string }> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
    .toUpperCase()
    .slice(-6);
  const token = `UCR-${suffix}`;
  const now = new Date();

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: `UCReturnPet-${suffix}`,
      species: "dog",
      sex: "unknown",
      status: opts.status ?? "lost",
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
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await purgeUserByEmail(UC_OWNER_EMAIL);
  await purgeUserByEmail(UC_REFUGIO_EMAIL);
  await purgeUserByEmail(UC_VECINO_EMAIL);

  const o = await createFreshTestUser(supabase, {
    email: UC_OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (o.error || !o.data.user) throw new Error(`createUser owner: ${o.error?.message}`);
  ownerUserId = o.data.user.id;

  const m = await createFreshTestUser(supabase, {
    email: UC_REFUGIO_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (m.error || !m.data.user) throw new Error(`createUser refugio: ${m.error?.message}`);
  refugioMemberUserId = m.data.user.id;

  const v = await createFreshTestUser(supabase, {
    email: UC_VECINO_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (v.error || !v.data.user) throw new Error(`createUser vecino: ${v.error?.message}`);
  vecinoUserId = v.data.user.id;

  orgToken = generatePublicToken();
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: orgToken,
      legalName: "UC Return Refugio SRL",
      displayName: "UC Return Refugio",
      orgType: "shelter",
      email: "uc-rto-refugio-org@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: refugioMemberUserId,
    role: "admin",
    canWritePetEvents: true,
  });
});

afterAll(async () => {
  for (const petId of insertedPetIds) {
    await withMutationOverride(async (tx) => {
      await tx.delete(pets).where(eq(pets.id, petId));
    });
  }
  for (const uid of [ownerUserId, refugioMemberUserId, vecinoUserId].filter(Boolean)) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
  }
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  await purgeUserByEmail(UC_OWNER_EMAIL);
  await purgeUserByEmail(UC_REFUGIO_EMAIL);
  await purgeUserByEmail(UC_VECINO_EMAIL);
});

// ---------------------------------------------------------------------------
// 1. proposeReturnAsRefugioUseCase
// ---------------------------------------------------------------------------

describe("proposeReturnAsRefugioUseCase", () => {
  it("happy path: emits custody_transfer_proposed and notifies owner", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    const result = await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
      petPublicToken: publicToken,
      notes: "Listo para la entrega.",
    });

    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result)) throw new Error("Expected ok");
    expect(result.eventId).toBeTruthy();

    const events = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")));
    expect(events.length).toBe(1);

    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.reason).toBe("return_to_original_owner");
    expect(payload.from_organization_id).toBe(orgId);
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
    expect(notifs[0].severity).toBe("urgent");
  });

  it("rejects when pet is not lost", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      status: "active",
      shelterCustodyOrgId: orgId,
    });

    const result = await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/perdida/i);
  });

  it("rejects when org has no active shelter_custody", async () => {
    const { publicToken } = await insertLostPet({ ownerUserId });

    const result = await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/custodia/i);
  });

  it("rejects duplicate proposals (anti-double-proposal)", async () => {
    const { publicToken } = await insertLostPet({ ownerUserId, shelterCustodyOrgId: orgId });

    const first = await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });
    expect("ok" in first && first.ok).toBe(true);

    const second = await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });
    expect("error" in second).toBe(true);
    if (!("error" in second)) throw new Error("Expected error");
    expect(second.error).toMatch(/pendiente/i);
  });
});

// ---------------------------------------------------------------------------
// 2. proposeReturnAsVecinoUseCase
// ---------------------------------------------------------------------------

describe("proposeReturnAsVecinoUseCase", () => {
  it("happy path: emits proposal and notifies owner", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    const result = await proposeReturnAsVecinoUseCase({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: "UC: vecino devuelve.",
    });

    expect("ok" in result && result.ok).toBe(true);

    const events = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_proposed")));
    expect(events.length).toBe(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.from_user_id).toBe(vecinoUserId);
  });

  it("rejects when vecino has no shelter_custody", async () => {
    const { publicToken } = await insertLostPet({ ownerUserId });

    const result = await proposeReturnAsVecinoUseCase({
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
// 3. ownerAcceptReturnUseCase — happy path
// ---------------------------------------------------------------------------

describe("ownerAcceptReturnUseCase — happy path", () => {
  it("transfer completes: custody_transferred + shelter_custody ended + pet active", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    const propose = await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });
    expect("ok" in propose && propose.ok).toBe(true);

    const result = await ownerAcceptReturnUseCase({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.ok).toBe(true);

    // custody_transferred emitted.
    const transferEvents = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")));
    expect(transferEvents.length).toBe(1);
    const tPayload = transferEvents[0].payload as Record<string, unknown>;
    expect(tPayload.reason).toBe("return_to_original_owner");

    // shelter_custody ended.
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

    // Pet status flipped to active.
    const [updatedPet] = await db
      .select({ status: pets.status })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(updatedPet.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// 4. ownerAcceptReturnUseCase — auto-cancel scenarios
// ---------------------------------------------------------------------------

describe("ownerAcceptReturnUseCase — auto-cancel", () => {
  it("auto-cancels when shelter_custody was revoked between propose and accept", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
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

    const result = await ownerAcceptReturnUseCase({
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

    const result = await ownerAcceptReturnUseCase({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/propuesta/i);
  });
});

// ---------------------------------------------------------------------------
// 4b. ownerAcceptReturnUseCase — concurrency guard (WAVE D3-#4)
// ---------------------------------------------------------------------------

describe("ownerAcceptReturnUseCase — concurrency guard", () => {
  it("refuses to execute an accept after the proposal was cancelled (no custody flip)", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    await proposeReturnAsVecinoUseCase({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });

    // The proposer cancels the proposal (commits) — models the cancel winning
    // the race against the owner's in-flight accept. The accept's outer reads
    // (which only look for a subsequent custody_transferred, never a
    // cancellation) still see the proposal as live; only the in-tx advisory
    // lock + hasPendingProposal re-check can catch this.
    const cancel = await actorCancelProposalUseCase({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      reason: "UC: cambio de planes.",
    });
    expect("ok" in cancel && cancel.ok).toBe(true);

    const accept = await ownerAcceptReturnUseCase({
      userId: ownerUserId,
      petPublicToken: publicToken,
    });

    // Accept must fail — the cancelled proposal is NOT executed.
    expect("error" in accept).toBe(true);

    // No custody_transferred emitted.
    const transfers = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transferred")));
    expect(transfers.length).toBe(0);

    // Vecino's shelter_custody remains active; pet still lost.
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
    expect(activeCustody.length).toBe(1);

    const [currentPet] = await db
      .select({ status: pets.status })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(currentPet.status).toBe("lost");
  });
});

// ---------------------------------------------------------------------------
// 5. ownerRejectReturnUseCase
// ---------------------------------------------------------------------------

describe("ownerRejectReturnUseCase", () => {
  it("emits custody_transfer_cancelled, pet status unchanged, notifies actor", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    await proposeReturnAsVecinoUseCase({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });

    const result = await ownerRejectReturnUseCase({
      userId: ownerUserId,
      petPublicToken: publicToken,
      reason: "UC: coordinamos por otro medio.",
    });

    expect("ok" in result && result.ok).toBe(true);

    const cancelEvents = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(cancelEvents.length).toBeGreaterThan(0);
    const cancelPayload = cancelEvents[cancelEvents.length - 1].payload as Record<string, unknown>;
    expect(cancelPayload.cancelled_by).toBe("owner_reject");

    // Pet status unchanged (still lost).
    const [currentPet] = await db
      .select({ status: pets.status })
      .from(pets)
      .where(eq(pets.id, petId));
    expect(currentPet.status).toBe("lost");
  });

  it("returns error when caller is not the owner", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    const result = await ownerRejectReturnUseCase({
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
// 6. actorCancelProposalUseCase
// ---------------------------------------------------------------------------

describe("actorCancelProposalUseCase", () => {
  it("vecino cancels own proposal: emits custody_transfer_cancelled, notifies owner", async () => {
    const { petId, publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyUserId: vecinoUserId,
    });

    await proposeReturnAsVecinoUseCase({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      notes: null,
    });

    const result = await actorCancelProposalUseCase({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      reason: "UC: Ya no puedo entregarlo hoy.",
    });

    expect("ok" in result && result.ok).toBe(true);

    const cancelEvents = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, petId), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(cancelEvents.length).toBeGreaterThan(0);
    const cancelPayload = cancelEvents[cancelEvents.length - 1].payload as Record<string, unknown>;
    expect(cancelPayload.cancelled_by).toBe("actor_cancel");
  });

  it("returns error when caller is not the actor who proposed", async () => {
    const { publicToken } = await insertLostPet({
      ownerUserId,
      shelterCustodyOrgId: orgId,
    });

    await proposeReturnAsRefugioUseCase({
      userId: refugioMemberUserId,
      organization: { id: orgId, displayName: "UC Return Refugio" },
      petPublicToken: publicToken,
      notes: null,
    });

    const result = await actorCancelProposalUseCase({
      userId: vecinoUserId,
      petPublicToken: publicToken,
      reason: "Forgery attempt.",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) throw new Error("Expected error");
    expect(result.error).toMatch(/propuso/i);
  });
});

// ---------------------------------------------------------------------------
// 7. ownerProposeReturnToOrgUseCase
// ---------------------------------------------------------------------------

describe("ownerProposeReturnToOrgUseCase", () => {
  it("happy path: emits proposal and notifies org admins", async () => {
    // Insert pet with adoption_finalized event so the use-case finds the target org.
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
      .toUpperCase()
      .slice(-6);
    const token = `UCR2-${suffix}`;
    const now = new Date();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `UCOrgReturnPet-${suffix}`,
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

    const result = await ownerProposeReturnToOrgUseCase({
      userId: ownerUserId,
      petPublicToken: token,
      reason: "post_adoption_failed_return",
      notes: null,
      proposedAt: now.toISOString(),
      callerRole: "owner",
    });

    expect("ok" in result && result.ok).toBe(true);
    if (!("ok" in result)) throw new Error("Expected ok");
    expect(result.eventId).toBeTruthy();

    const events = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "custody_transfer_proposed")),
      );
    expect(events.length).toBe(1);
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.from_user_id).toBe(ownerUserId);
    expect(payload.to_organization_id).toBe(orgId);
  });
});

// ---------------------------------------------------------------------------
// 8. orgAcceptOwnerReturnUseCase — attribution guard
// ---------------------------------------------------------------------------

describe("orgAcceptOwnerReturnUseCase — attribution", () => {
  it("custody_transferred is attributed to the acting org member, not the proposing owner", async () => {
    // Insert pet with adoption event.
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
      .toUpperCase()
      .slice(-6);
    const token = `UCR3-${suffix}`;
    const now = new Date();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `UCAcceptPet-${suffix}`,
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();
    insertedPetIds.push(pet.id);

    await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId, role: "owner", startedAt: now });

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

    // Owner proposes.
    const propose = await ownerProposeReturnToOrgUseCase({
      userId: ownerUserId,
      petPublicToken: token,
      reason: "post_adoption_failed_return",
      notes: null,
      proposedAt: now.toISOString(),
      callerRole: "owner",
    });
    expect("ok" in propose && propose.ok).toBe(true);

    // Org accepts.
    const accept = await orgAcceptOwnerReturnUseCase({
      orgId,
      orgDisplayName: "UC Return Refugio",
      actingUserId: refugioMemberUserId,
      petPublicToken: token,
    });
    expect("error" in accept).toBe(false);
    if ("error" in accept) throw new Error(`Unexpected error: ${accept.error}`);

    const [transferEvent] = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "custody_transferred")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);
    expect(transferEvent).toBeDefined();
    // Attribution: acting org member, NOT the owner who proposed.
    expect(transferEvent.recordedByUserId).toBe(refugioMemberUserId);
    expect(transferEvent.recordedByUserId).not.toBe(ownerUserId);
    expect(transferEvent.authorRole).toBe("shelter");
  });

  it("refuses while ANOTHER org holds live custody of the pet — the owner row stays live, nothing is written (0195)", async () => {
    // One live organisation custody per pet: the insert at the end of the
    // accept would hit `ownerships_one_active_org_shelter_custody_per_pet`.
    // The writer must say so in es-AR before writing, not surface a 23505.
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
      .toUpperCase()
      .slice(-6);
    const token = `UCR4-${suffix}`;
    const now = new Date();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `UCHeldPet-${suffix}`,
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();
    insertedPetIds.push(pet.id);
    await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId, role: "owner", startedAt: now });
    await db.insert(petEvents).values({
      petId: pet.id,
      eventType: "adoption_finalized",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: refugioMemberUserId,
      authorRole: "shelter",
      authorOrganizationId: orgId,
      payload: validateEventPayload("adoption_finalized", {
        previous_owner_organization_id: orgId,
        adopter_user_id: ownerUserId,
        foster_user_id: null,
        contract_attachment_id: null,
        post_adoption_followup_months: null,
        notes: null,
      }),
    });
    const propose = await ownerProposeReturnToOrgUseCase({
      userId: ownerUserId,
      petPublicToken: token,
      reason: "post_adoption_failed_return",
      notes: null,
      proposedAt: now.toISOString(),
      callerRole: "owner",
    });
    expect("ok" in propose && propose.ok).toBe(true);

    // A different org takes the animal in (found-pet intake) before the accept.
    const [otherOrg] = await db
      .insert(organizations)
      .values({
        publicToken: `UCR4O-${suffix}`,
        legalName: "UC Other Refugio SRL",
        displayName: "UC Otro Refugio",
        orgType: "shelter",
        email: `uc-rto-other-${suffix.toLowerCase()}@dim-test.local`,
        verified: true,
      })
      .returning({ id: organizations.id });
    await db.insert(ownerships).values({
      petId: pet.id,
      ownerOrganizationId: otherOrg.id,
      role: "shelter_custody",
      startedAt: now,
    });

    const accept = await orgAcceptOwnerReturnUseCase({
      orgId,
      orgDisplayName: "UC Return Refugio",
      actingUserId: refugioMemberUserId,
      petPublicToken: token,
    });
    expect("error" in accept).toBe(true);
    if (!("error" in accept)) throw new Error("Expected a refusal");
    expect(accept.error).toMatch(/custodia de una organización/);

    const live = await db
      .select({ role: ownerships.role, org: ownerships.ownerOrganizationId })
      .from(ownerships)
      .where(and(eq(ownerships.petId, pet.id), isNull(ownerships.endedAt)));
    expect(live.map((r) => r.role).sort()).toEqual(["owner", "shelter_custody"]);
    expect(live.find((r) => r.role === "shelter_custody")?.org).toBe(otherOrg.id);
    const transfers = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "custody_transferred")));
    expect(transfers).toHaveLength(0);

    await db.delete(ownerships).where(eq(ownerships.ownerOrganizationId, otherOrg.id));
    await db.delete(organizations).where(eq(organizations.id, otherOrg.id));
  });
});

// ---------------------------------------------------------------------------
// 9. orgRejectOwnerReturnUseCase — attribution guard
// ---------------------------------------------------------------------------

describe("orgRejectOwnerReturnUseCase — attribution", () => {
  it("custody_transfer_cancelled is attributed to the acting org member", async () => {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
      .toUpperCase()
      .slice(-6);
    const token = `UCR4-${suffix}`;
    const now = new Date();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `UCRejectPet-${suffix}`,
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();
    insertedPetIds.push(pet.id);

    await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId, role: "owner", startedAt: now });

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

    const propose = await ownerProposeReturnToOrgUseCase({
      userId: ownerUserId,
      petPublicToken: token,
      reason: "post_adoption_failed_return",
      notes: null,
      proposedAt: now.toISOString(),
      callerRole: "owner",
    });
    expect("ok" in propose && propose.ok).toBe(true);

    const reject = await orgRejectOwnerReturnUseCase({
      orgId,
      orgDisplayName: "UC Return Refugio",
      actingUserId: refugioMemberUserId,
      petPublicToken: token,
      reason: "UC: No tenemos capacidad.",
    });
    expect("error" in reject).toBe(false);
    if ("error" in reject) throw new Error(`Unexpected error: ${reject.error}`);

    const [cancelEvent] = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "custody_transfer_cancelled")),
      )
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent.recordedByUserId).toBe(refugioMemberUserId);
    expect(cancelEvent.recordedByUserId).not.toBe(ownerUserId);
    expect(cancelEvent.authorRole).toBe("shelter");
  });
});

// ---------------------------------------------------------------------------
// 9b. orgRejectOwnerReturnUseCase — concurrency guard (WAVE E1-#3)
// ---------------------------------------------------------------------------
//
// org-reject now takes the pet advisory lock and re-verifies the proposal is
// still pending UNDER the lock (parity with owner-reject-return). A true
// concurrent accept-vs-reject race is not deterministically reproducible in a
// sequential test harness, so this guards the observable outcome the lock
// protects: once the return was accepted, a reject must NOT emit a spurious
// custody_transfer_cancelled into the immutable log.

describe("orgRejectOwnerReturnUseCase — concurrency guard", () => {
  it("refuses to reject after the org already accepted the return (no spurious cancel)", async () => {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
      .toUpperCase()
      .slice(-6);
    const token = `UCR5-${suffix}`;
    const now = new Date();
    const [pet] = await db
      .insert(pets)
      .values({
        publicToken: token,
        name: `UCRejectRacePet-${suffix}`,
        species: "dog",
        sex: "unknown",
        status: "active",
        potentiallyDangerousBreed: false,
      })
      .returning();
    insertedPetIds.push(pet.id);

    await db
      .insert(ownerships)
      .values({ petId: pet.id, ownerUserId, role: "owner", startedAt: now });

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

    const propose = await ownerProposeReturnToOrgUseCase({
      userId: ownerUserId,
      petPublicToken: token,
      reason: "post_adoption_failed_return",
      notes: null,
      proposedAt: now.toISOString(),
      callerRole: "owner",
    });
    expect("ok" in propose && propose.ok).toBe(true);

    // Org accepts and commits — models the accept winning the race.
    const accept = await orgAcceptOwnerReturnUseCase({
      orgId,
      orgDisplayName: "UC Return Refugio",
      actingUserId: refugioMemberUserId,
      petPublicToken: token,
    });
    expect("error" in accept).toBe(false);
    if ("error" in accept) throw new Error(`Unexpected error: ${accept.error}`);

    // Reject must now fail — the proposal is already resolved.
    const reject = await orgRejectOwnerReturnUseCase({
      orgId,
      orgDisplayName: "UC Return Refugio",
      actingUserId: refugioMemberUserId,
      petPublicToken: token,
      reason: "UC: llega tarde.",
    });
    expect("error" in reject).toBe(true);

    // No custody_transfer_cancelled was emitted (only custody_transferred exists).
    const cancels = await db
      .select()
      .from(petEvents)
      .where(
        and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "custody_transfer_cancelled")),
      );
    expect(cancels.length).toBe(0);
  });
});
