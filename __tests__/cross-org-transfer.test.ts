// Integration tests for cross-org transfer handshake (spec
// 2026-05-19-cross-org-transfer-ux-design).
//
// The full server actions require formData + supabase auth so we
// exercise the contract by emulating the action's tx steps and the
// cron closer directly.

import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cases, db, organizations, ownerships, petEvents, pets } from "@/db";
import { TransfersRepository } from "@/src/modules/transfers/infrastructure/transfers-repository";

const findExpiredCrossOrgTransfers =
  TransfersRepository.findExpirableCrossOrgCases.bind(TransfersRepository);
const expireCrossOrgTransfer = (
  candidate: Parameters<typeof TransfersRepository.expireOneCrossOrgCase>[0],
) => TransfersRepository.expireOneCrossOrgCase(candidate);
import { validateEventPayload } from "@/lib/events/event-schemas";
import { closeCase, openCase } from "@/lib/infra/case-helpers";
import { V1_CASE_KINDS } from "@/src/modules/cases/domain/case-kinds";
import { getLifecycle } from "@/src/modules/cases/domain/lifecycles";
import { withMutationOverride } from "./_helpers/db-overrides";

const SENDER_TOKEN = "DIM-XO-SND1";
const RECEIVER_TOKEN = "DIM-XO-RCV1";
const PET_TOKEN = "DIM-XO-PA1";

let senderId: string;
let receiverId: string;
let petId: string;
let caseId: string;

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
    await tx.execute(
      sql`DELETE FROM organizations WHERE public_token IN (${SENDER_TOKEN}, ${RECEIVER_TOKEN})`,
    );
  });

  const [sender] = await db
    .insert(organizations)
    .values({
      publicToken: SENDER_TOKEN,
      legalName: "Refugio Sender SRL",
      displayName: "Refugio Sender",
      orgType: "shelter",
      email: "xo-sender@dim-test.local",
      verified: true,
    })
    .returning();
  senderId = sender.id;

  const [receiver] = await db
    .insert(organizations)
    .values({
      publicToken: RECEIVER_TOKEN,
      legalName: "Refugio Receiver SRL",
      displayName: "Refugio Receiver",
      orgType: "shelter",
      email: "xo-receiver@dim-test.local",
      verified: true,
    })
    .returning();
  receiverId = receiver.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "CrossOrgTest",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;

  await db.insert(ownerships).values({
    petId,
    ownerOrganizationId: senderId,
    role: "shelter_custody",
    startedAt: new Date(),
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${petId}`);
    // Two cases may exist (the happy-path one + the stale-cron one). Wipe
    // everything for this pet so the pets DELETE doesn't trip on
    // cases_primary_pet_id_fkey.
    await tx.execute(sql`DELETE FROM cases WHERE primary_pet_id = ${petId}`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${petId}`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${petId}`);
    await tx.execute(
      sql`DELETE FROM organizations WHERE id IN (${senderId}::uuid, ${receiverId}::uuid)`,
    );
  });
});

describe("custody_transfer_handshake — V1 catalog", () => {
  it("is included in V1_CASE_KINDS", () => {
    expect(V1_CASE_KINDS).toContain("custody_transfer_handshake");
  });

  it("has a registered lifecycle with cronCloseRoute set", () => {
    const lifecycle = getLifecycle("custody_transfer_handshake");
    expect(lifecycle).not.toBeNull();
    expect(lifecycle?.cronCloseRoute).toBe("/api/cron/expire-cross-org-transfers");
    expect(lifecycle?.reopenAllowed).toBe(false);
  });
});

describe("cross-org transfer — propose + accept happy path", () => {
  it("propose opens a case with the proposal event attached and receiver_org persisted", async () => {
    await db.transaction(async (tx) => {
      const c = await openCase(
        {
          kind: "custody_transfer_handshake",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          openedByOrganizationId: senderId,
          receiverOrganizationId: receiverId,
          openedReason: { code: "cross_org_transfer_proposed", reason: "space_constraint" },
        },
        tx,
      );
      caseId = c.id;

      const payload = validateEventPayload("custody_transfer_proposed", {
        from_user_id: null,
        from_organization_id: senderId,
        to_user_id: null,
        to_organization_id: receiverId,
        reason: "space_constraint",
        notes: null,
        matched_against_pet_id: null,
        proposed_at: new Date().toISOString(),
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transfer_proposed",
        occurredAt: new Date(),
        recordedAt: new Date(),
        authorRole: "shelter",
        authorOrganizationId: senderId,
        payload,
        caseId: c.id,
      });
    });

    const [row] = await db
      .select({
        status: cases.status,
        caseKind: cases.caseKind,
        openedByOrganizationId: cases.openedByOrganizationId,
        receiverOrganizationId: cases.receiverOrganizationId,
      })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(row.status).toBe("open");
    expect(row.caseKind).toBe("custody_transfer_handshake");
    // §4.2 / migration 0043: canonical receiver column is populated at open time.
    expect(row.openedByOrganizationId).toBe(senderId);
    expect(row.receiverOrganizationId).toBe(receiverId);
  });

  it("accept emits custody_transferred + flips ownerships + closes the case", async () => {
    await db.transaction(async (tx) => {
      const now = new Date();
      const transferPayload = validateEventPayload("custody_transferred", {
        from_user_id: null,
        from_organization_id: senderId,
        to_user_id: null,
        to_organization_id: receiverId,
        from_role: "shelter_custody",
        to_role: "shelter_custody",
        reason: "space_constraint",
        matched_against_pet_id: null,
        foster_ended_event_id: null,
        notes: null,
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transferred",
        occurredAt: now,
        recordedAt: now,
        authorRole: "shelter",
        authorOrganizationId: receiverId,
        payload: transferPayload,
        caseId,
      });
      await tx
        .update(ownerships)
        .set({ endedAt: now })
        .where(
          and(
            eq(ownerships.petId, petId),
            eq(ownerships.ownerOrganizationId, senderId),
            eq(ownerships.role, "shelter_custody"),
            isNull(ownerships.endedAt),
          ),
        );
      await tx.insert(ownerships).values({
        petId,
        ownerOrganizationId: receiverId,
        role: "shelter_custody",
        startedAt: now,
      });
      await closeCase({ caseId, reason: "resolved" }, tx);
    });

    const [closed] = await db
      .select({ status: cases.status, closedReason: cases.closedReason })
      .from(cases)
      .where(eq(cases.id, caseId));
    expect(closed.status).toBe("closed");
    expect(closed.closedReason).toBe("resolved");

    // Sender's shelter_custody ended, receiver's active.
    const senderActive = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, senderId),
          isNull(ownerships.endedAt),
        ),
      );
    const receiverActive = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.ownerOrganizationId, receiverId),
          isNull(ownerships.endedAt),
        ),
      );
    expect(senderActive.length).toBe(0);
    expect(receiverActive.length).toBe(1);
  });
});

describe("cross-org transfer — expire cron", () => {
  let staleCaseId: string;

  beforeAll(async () => {
    // Open a fresh handshake "31 days ago" so the cron picks it up.
    await db.transaction(async (tx) => {
      const c = await openCase(
        {
          kind: "custody_transfer_handshake",
          primarySubjectKind: "registered_pet",
          primaryPetId: petId,
          openedByOrganizationId: senderId,
          openedReason: { code: "cross_org_transfer_proposed", reason: "other" },
        },
        tx,
      );
      staleCaseId = c.id;
      // Backdate opened_at directly via SQL — the helper inserts now().
      await tx.execute(
        sql`UPDATE cases SET opened_at = ${new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString()}::timestamptz WHERE id = ${staleCaseId}`,
      );

      const payload = validateEventPayload("custody_transfer_proposed", {
        from_user_id: null,
        from_organization_id: senderId,
        to_user_id: null,
        to_organization_id: receiverId,
        reason: "shelter_closing",
        notes: null,
        matched_against_pet_id: null,
        proposed_at: new Date().toISOString(),
      });
      await tx.insert(petEvents).values({
        petId,
        eventType: "custody_transfer_proposed",
        occurredAt: new Date(),
        recordedAt: new Date(),
        authorRole: "shelter",
        authorOrganizationId: senderId,
        payload,
        caseId: c.id,
      });
    });
  });

  it("scan finds the stale handshake", async () => {
    const candidates = await findExpiredCrossOrgTransfers();
    expect(candidates.some((c) => c.id === staleCaseId)).toBe(true);
  });

  it("expire flips status to closed with closed_reason='auto_expired'", async () => {
    const candidates = await findExpiredCrossOrgTransfers();
    const candidate = candidates.find((c) => c.id === staleCaseId);
    expect(candidate).toBeDefined();
    if (!candidate) return;
    await expireCrossOrgTransfer(candidate);

    const [row] = await db
      .select({ status: cases.status, closedReason: cases.closedReason })
      .from(cases)
      .where(eq(cases.id, staleCaseId));
    expect(row.status).toBe("closed");
    expect(row.closedReason).toBe("auto_expired");
  });

  it("is idempotent — already-closed cases drop out of the scan", async () => {
    const candidates = await findExpiredCrossOrgTransfers();
    expect(candidates.some((c) => c.id === staleCaseId)).toBe(false);
  });

  // L-8 (loop fase 1, 2026-08-23): the expiry wrote the "Auto-expirada" note
  // and notified BOTH orgs before it knew whether it had actually closed
  // anything. Its in-tx re-check was an unlocked SELECT, so an accept
  // committing between that read and `closeCase` left the guarded UPDATE
  // touching zero rows — and its result was DISCARDED, so the loser could not
  // tell. The pet's timeline then carries a permanent system note saying the
  // receiver never answered, on a handshake that was accepted, and both orgs
  // get told so.
  //
  // The repo already had the method built for exactly this: `closeCaseOwned`,
  // whose own docblock says the plain `closeCase` "no alcanza cuando el efecto
  // es un evento ... append-only por trigger". Claim first, then write only if
  // we won — the order `operator-actions.ts` spells out.
  describe("L-8 — a lost expiry race writes no note and notifies nobody", () => {
    it("claims the close with closeCaseOwned, and the note + notifications hang off the claim", async () => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const src = readFileSync(
        join(__dirname, "..", "src/modules/transfers/infrastructure/transfers-repository.ts"),
        "utf8",
      );
      const start = src.indexOf("async expireOneCrossOrgCase(");
      expect(start, "expireOneCrossOrgCase").toBeGreaterThanOrEqual(0);
      const body = src.slice(start, src.indexOf("\n  async ", start + 1));

      // The atomic claim replaces the unlocked re-check as the decision.
      expect(body).toContain("closeCaseOwned(");
      const claimAt = body.indexOf("closeCaseOwned(");
      const noteAt = body.indexOf('eventType: "note_added"');
      const notifyAt = body.indexOf("organizationMemberships");
      expect(noteAt, "the Auto-expirada note").toBeGreaterThan(claimAt);
      expect(notifyAt, "the coordinator notifications").toBeGreaterThan(claimAt);
      // And the loser leaves before either of them.
      expect(body).toMatch(/if \(!won\)[\s\S]{0,80}return/);
    });

    it("writes nothing when the case was already closed by the accept", async () => {
      // `cases_open_per_pet_kind_idx` allows one open handshake per pet, so
      // clear whatever earlier arms left open before opening this one.
      await db
        .update(cases)
        .set({ status: "closed", closedReason: "cancelled", closedAt: new Date() })
        .where(
          and(
            eq(cases.primaryPetId, petId),
            eq(cases.caseKind, "custody_transfer_handshake"),
            eq(cases.status, "open"),
          ),
        );

      // Deterministic half of the race: the accept won and committed. (The
      // millisecond window itself needs two connections, which this repo has no
      // harness for — see src/modules/rehome/__tests__/owner-row-lock.test.ts.)
      const c = await db.transaction(async (tx) =>
        openCase(
          {
            kind: "custody_transfer_handshake",
            primarySubjectKind: "registered_pet",
            primaryPetId: petId,
            openedByOrganizationId: senderId,
            receiverOrganizationId: receiverId,
            openedReason: { code: "cross_org_transfer_proposed", reason: "other" },
          },
          tx,
        ),
      );
      await db.transaction(async (tx) => {
        await closeCase({ caseId: c.id, reason: "resolved" }, tx);
      });

      await expireCrossOrgTransfer({
        id: c.id,
        publicCode: c.publicCode,
        primaryPetId: petId,
        openedByOrganizationId: senderId,
        receiverOrganizationId: receiverId,
      });

      const notes = await db
        .select({ id: petEvents.id })
        .from(petEvents)
        .where(and(eq(petEvents.caseId, c.id), eq(petEvents.eventType, "note_added")));
      expect(notes).toHaveLength(0);

      const [row] = await db
        .select({ closedReason: cases.closedReason })
        .from(cases)
        .where(eq(cases.id, c.id));
      expect(row.closedReason).toBe("resolved");
    });
  });
});
