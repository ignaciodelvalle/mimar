// Integration tests for the foster proposal expirer cron helper.
// Mirrors the structure of chip-match.test.ts — ephemeral Supabase auth
// users + DB fixtures, cleaned up in afterAll.

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  db,
  fosterProposals,
  fosterVolunteers,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { generatePrefixedToken, generatePublicToken } from "@/lib/infra/publicToken";
import { expireFosterProposalsAction as expireFosterProposals } from "@/src/modules/foster/actions";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabase = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const VOLUNTEER_EMAIL = "fpe-volunteer@dim-test.local";
const COORD_EMAIL = "fpe-coord@dim-test.local";
const PASS = "FPExpire_2026!";

let volunteerUserId: string;
let coordUserId: string;
let orgId: string;
let petId: string;

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
  for (const uid of ids) {
    await db.delete(notifications).where(eq(notifications.userId, uid));
    await db.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
    await db.delete(fosterVolunteers).where(eq(fosterVolunteers.userId, uid));
    await db.delete(profiles).where(eq(profiles.id, uid));
  }
  if (found) await supabase.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  await purgeUserByEmail(VOLUNTEER_EMAIL);
  await purgeUserByEmail(COORD_EMAIL);

  const v = await createFreshTestUser(supabase, {
    email: VOLUNTEER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (v.error || !v.data.user) throw new Error(`createUser volunteer: ${v.error?.message}`);
  volunteerUserId = v.data.user.id;

  const c = await createFreshTestUser(supabase, {
    email: COORD_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (c.error || !c.data.user) throw new Error(`createUser coord: ${c.error?.message}`);
  coordUserId = c.data.user.id;

  // Test org.
  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: generatePublicToken(),
      legalName: "FPE Test Refugio SRL",
      displayName: "FPE Test Refugio",
      orgType: "shelter",
      email: "fpe-org@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  // Coordinator as admin (implicit foster.assign).
  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: coordUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  // Test pet in shelter_custody by the org.
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: generatePublicToken(),
      name: "FPETestPet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;
  await db.insert(ownerships).values({
    petId,
    ownerOrganizationId: orgId,
    role: "shelter_custody",
    startedAt: new Date(),
  });

  // Volunteer enrolled.
  await db.insert(fosterVolunteers).values({
    userId: volunteerUserId,
    status: "active",
    availableSlots: 1,
    acceptsDogs: true,
  });
});

afterAll(async () => {
  await db.delete(fosterProposals).where(eq(fosterProposals.petId, petId));
  await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  await withMutationOverride(async (tx) => {
    await tx.delete(pets).where(eq(pets.id, petId));
  });
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await purgeUserByEmail(VOLUNTEER_EMAIL);
  await purgeUserByEmail(COORD_EMAIL);
});

async function insertProposal(opts: {
  status: "pending" | "rejected";
  expiresAtMsFromNow: number;
}): Promise<{ id: string; publicToken: string }> {
  const token = generatePrefixedToken("FP");
  const now = new Date();
  const isRejected = opts.status === "rejected";
  const [row] = await db
    .insert(fosterProposals)
    .values({
      publicToken: token,
      organizationId: orgId,
      volunteerUserId,
      petId,
      proposedByUserId: coordUserId,
      proposedAt: now,
      matchWarnings: [],
      expiresAt: new Date(now.getTime() + opts.expiresAtMsFromNow),
      status: opts.status,
      ...(isRejected ? { respondedAt: now, rejectionReason: "other" as const } : {}),
    })
    .returning({ id: fosterProposals.id });
  return { id: row.id, publicToken: token };
}

describe("expireFosterProposals", () => {
  it("expires pending proposals past their deadline", async () => {
    // Clean slate.
    await db.delete(fosterProposals).where(eq(fosterProposals.petId, petId));

    const stale = await insertProposal({ status: "pending", expiresAtMsFromNow: -1000 });
    const fresh = await insertProposal({ status: "pending", expiresAtMsFromNow: 60_000 });

    const stats = await expireFosterProposals();
    expect(stats.candidates).toBe(1);
    expect(stats.expired).toBe(1);
    expect(stats.errors).toBe(0);

    const [staleRow] = await db
      .select({ status: fosterProposals.status })
      .from(fosterProposals)
      .where(eq(fosterProposals.id, stale.id));
    expect(staleRow.status).toBe("expired");

    const [freshRow] = await db
      .select({ status: fosterProposals.status })
      .from(fosterProposals)
      .where(eq(fosterProposals.id, fresh.id));
    expect(freshRow.status).toBe("pending");

    // Verify the event was emitted.
    const events = await db
      .select()
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "foster_proposal_resolved")));
    const expired = events.filter((e) => (e.payload as { outcome?: string }).outcome === "expired");
    expect(expired.length).toBeGreaterThanOrEqual(1);

    // Cleanup the events (they're append-only — need GUC).
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    });
  });

  it("is idempotent — second run finds zero candidates", async () => {
    await db.delete(fosterProposals).where(eq(fosterProposals.petId, petId));
    await insertProposal({ status: "pending", expiresAtMsFromNow: -2000 });

    const first = await expireFosterProposals();
    expect(first.expired).toBe(1);

    const second = await expireFosterProposals();
    expect(second.candidates).toBe(0);
    expect(second.expired).toBe(0);

    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    });
  });

  it("skips non-pending proposals even with expired deadline", async () => {
    await db.delete(fosterProposals).where(eq(fosterProposals.petId, petId));
    const rejected = await insertProposal({ status: "rejected", expiresAtMsFromNow: -5000 });

    const stats = await expireFosterProposals();
    expect(stats.candidates).toBe(0);

    const [row] = await db
      .select({ status: fosterProposals.status })
      .from(fosterProposals)
      .where(eq(fosterProposals.id, rejected.id));
    expect(row.status).toBe("rejected");
  });

  it("recovery — proposals that survived a partial prior run are picked up on the next run", async () => {
    // Simulate a partial prior run: two stale pending proposals exist. The
    // prior run expired one (we update it manually) but did not reach the
    // second (simulating a crash or per-row error mid-batch). The next full
    // run must pick up and expire the surviving pending one.
    await db.delete(fosterProposals).where(eq(fosterProposals.petId, petId));

    const alreadyExpired = await insertProposal({ status: "pending", expiresAtMsFromNow: -3000 });
    const survivingPending = await insertProposal({ status: "pending", expiresAtMsFromNow: -3000 });

    // Simulate the partial prior run: manually flip the first proposal to
    // 'expired' (as if a previous cron run succeeded for it but crashed before
    // reaching the second).
    await db
      .update(fosterProposals)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(fosterProposals.id, alreadyExpired.id));

    // The surviving proposal is still pending. Run the handler — it should
    // find exactly 1 candidate (the surviving one) and expire it.
    const stats = await expireFosterProposals();
    expect(stats.candidates).toBe(1);
    expect(stats.expired).toBe(1);
    expect(stats.errors).toBe(0);

    const [survivingRow] = await db
      .select({ status: fosterProposals.status })
      .from(fosterProposals)
      .where(eq(fosterProposals.id, survivingPending.id));
    expect(survivingRow.status).toBe("expired");

    // The already-expired row must still be 'expired' — not double-processed.
    const [alreadyRow] = await db
      .select({ status: fosterProposals.status })
      .from(fosterProposals)
      .where(eq(fosterProposals.id, alreadyExpired.id));
    expect(alreadyRow.status).toBe("expired");

    // Cleanup events emitted by expireFosterProposals.
    await withMutationOverride(async (tx) => {
      await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    });
  });
});
