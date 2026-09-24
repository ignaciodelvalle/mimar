// Integration tests — migration 0205: the five gaps the subject-rights RPCs had.
//
// The fence (`pnpm lint:subject-rights`) proves that each of these tables is
// MENTIONED by the right function. It cannot prove the WHERE clause is the
// right one — that is this file's job, against real rows.
//
// Covers (Ley 25.326):
//   art. 14 — export_subject_data returns pet_caretaker_grants (all three
//             predicates), foster_volunteers, org_contact_messages and
//             push_subscriptions, at schema_version 5 (0205 shipped these four
//             at 4; 0208 added three more sections and bumped it), and NEVER
//             hands back the RFC 8291 push encryption keys.
//   art. 16 — erase_subject_data, for BOTH sides of a caretaker grant:
//               · grantor  → pending cancelled, `note` nulled, the invitee's
//                            email LEFT ALONE (it is a third party's).
//               · invitee  → pending rejected, `caretaker_email` sentinelled,
//                            reached BY EMAIL when there is no account link.
//             Plus: foster_volunteers deleted, profiles.jurisdiction_* nulled,
//             the per-pet emergency/vet/insurance mirrors scrubbed, and
//             org_contact_messages losing both the raw IP and the body.
//
// THE ORDERING PROPERTY THIS FILE EXISTS TO PIN. The two pending flips identify
// the subject BY EMAIL and the sentinel then overwrites that email. Run them in
// the other order and a grant addressed to somebody with no account is never
// resolved — it just loses its address and stays pending forever, acceptable
// months later onto a stranger's animal. `erases the invitee side` is the test
// that fails if 0205's statement order is ever "tidied".
//
// RPC call pattern copied from subject-rights-pet-tags.test.ts: raw SQL through
// drizzle with request.jwt.claims spoofed inside one transaction.

import { createClient } from "@supabase/supabase-js";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditLog,
  db,
  fosterVolunteers,
  orgContactMessages,
  organizations,
  ownerships,
  petCaretakerGrants,
  pets,
  profiles,
  pushSubscriptions,
} from "@/db";
import { pgErrorCode } from "@/lib/infra/db-errors";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false } });

const GRANTOR_EMAIL = "sr0205-grantor@dim-test.local";
const INVITEE_EMAIL = "sr0205-invitee@dim-test.local";
const OTHER_OWNER_EMAIL = "sr0205-other-owner@dim-test.local";
const ALL_EMAILS = [GRANTOR_EMAIL, INVITEE_EMAIL, OTHER_OWNER_EMAIL];
const PASSWORD = "SubjRights0205_2026!";
const ERASED_SENTINEL = "erased@invalid.local";
const REDACTED = "[contenido eliminado a pedido del titular]";

let grantorUserId: string;
let inviteeUserId: string;
let otherOwnerUserId: string;
let grantorPetId: string;
let otherPetId: string;
/** Owned by the grantor once, transferred to otherOwner — the living third party. */
let transferredPetId: string;
/** Grant on the grantor's own pet, addressed to the invitee BY ACCOUNT. */
let byAccountGrantId: string;
/** Grant on a third party's pet, addressed to the invitee BY EMAIL only. */
let byEmailGrantId: string;
let orgId: string;
let contactMessageId: string;

async function callRpcAs<T>(
  callerUserId: string | null,
  fnSql: ReturnType<typeof sql>,
): Promise<{ data: T | null; error: { code?: string; message: string } | null }> {
  try {
    const result = await db.transaction(async (tx) => {
      const claims = callerUserId ? JSON.stringify({ sub: callerUserId }) : "";
      await tx.execute(sql`SELECT set_config('request.jwt.claims', ${claims}, true)`);
      const rows = (await tx.execute(fnSql)) as unknown as Array<Record<string, unknown>>;
      return rows[0] ? (Object.values(rows[0])[0] as T) : null;
    });
    return { data: result, error: null };
  } catch (err) {
    const e = err as { message?: string };
    return {
      data: null,
      error: { code: pgErrorCode(err) ?? undefined, message: e.message ?? "unknown" },
    };
  }
}

async function grantRow(id: string) {
  const [row] = await db
    .select({
      status: petCaretakerGrants.status,
      caretakerEmail: petCaretakerGrants.caretakerEmail,
      note: petCaretakerGrants.note,
      respondedAt: petCaretakerGrants.respondedAt,
      caretakerUserId: petCaretakerGrants.caretakerUserId,
    })
    .from(petCaretakerGrants)
    .where(eq(petCaretakerGrants.id, id));
  return row;
}

async function latestErasurePayload(userId: string): Promise<Record<string, number>> {
  const [row] = await db
    .select({ payload: auditLog.payload })
    .from(auditLog)
    .where(and(eq(auditLog.targetUserId, userId), eq(auditLog.action, "subject_erasure")))
    .orderBy(desc(auditLog.performedAt))
    .limit(1);
  return (row?.payload ?? {}) as Record<string, number>;
}

async function purge() {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = (list?.users ?? []).filter((u) => u.email && ALL_EMAILS.includes(u.email));
  await db.delete(orgContactMessages).where(eq(orgContactMessages.inquirerEmail, GRANTOR_EMAIL));
  await db.delete(orgContactMessages).where(eq(orgContactMessages.inquirerEmail, ERASED_SENTINEL));
  await db.delete(organizations).where(eq(organizations.email, "sr0205-org@dim-test.local"));
  for (const user of found) {
    const owned = await db
      .select({ petId: ownerships.petId })
      .from(ownerships)
      .where(eq(ownerships.ownerUserId, user.id));
    await db.delete(petCaretakerGrants).where(eq(petCaretakerGrants.grantedByUserId, user.id));
    await withMutationOverride(async (tx) => {
      for (const { petId } of owned) await tx.delete(pets).where(eq(pets.id, petId));
    });
    await admin.auth.admin.deleteUser(user.id);
  }
}

async function createUser(email: string): Promise<string> {
  const { data, error } = await createFreshTestUser(admin, {
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${email}): ${error?.message}`);
  return data.user.id;
}

async function createPet(token: string, ownerUserId: string): Promise<string> {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: "Subject Rights 0205 Pet",
      species: "dog",
      sex: "male",
      status: "active",
      emergencyContactName: "Vecina Marta",
      emergencyContactPhone: "+5491100000001",
      preferredVetName: "Dr. Quiroga",
      preferredVetPhone: "+5491100000002",
      insuranceCompany: "Mascota Segura SA",
      insurancePolicyNumber: "POL-0205-777",
    })
    .returning({ id: pets.id });
  await db.insert(ownerships).values({ petId: pet.id, ownerUserId, role: "owner" });
  return pet.id;
}

beforeAll(async () => {
  await purge();

  grantorUserId = await createUser(GRANTOR_EMAIL);
  inviteeUserId = await createUser(INVITEE_EMAIL);
  otherOwnerUserId = await createUser(OTHER_OWNER_EMAIL);

  const stamp = Date.now().toString(36).toUpperCase().slice(-4);
  grantorPetId = await createPet(`DIM-SR05-${stamp}`, grantorUserId);
  otherPetId = await createPet(`DIM-SR06-${stamp}`, otherOwnerUserId);

  // A pet the grantor owned and TRANSFERRED AWAY: their `owner` row is closed
  // (what `closeOwnerOwnerships` does on accept) and the buyer's is live. The
  // contact fields on it are now the buyer's — a living person who requested
  // nothing and is not the data subject.
  transferredPetId = await createPet(`DIM-SR07-${stamp}`, otherOwnerUserId);
  await db.insert(ownerships).values({
    petId: transferredPetId,
    ownerUserId: grantorUserId,
    role: "owner",
    endedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });

  // The account-level jurisdiction 0205 stops collecting. Written directly here
  // because the writer it used to have was removed in the same change.
  await db
    .update(profiles)
    .set({ jurisdictionProvince: "Buenos Aires", jurisdictionLocality: "La Plata" })
    .where(eq(profiles.id, grantorUserId));

  const inSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  // Grant 1 — the grantor's own pet, invitee identified BY ACCOUNT. The note is
  // the grantor's free text about a third party's household.
  const [byAccount] = await db
    .insert(petCaretakerGrants)
    .values({
      publicToken: `CUI-0205A-${stamp}`,
      petId: grantorPetId,
      grantedByUserId: grantorUserId,
      caretakerUserId: inviteeUserId,
      caretakerEmail: INVITEE_EMAIL,
      status: "pending",
      endsAt: inSevenDays,
      note: "Pampa toma media pastilla a la mañana.",
    })
    .returning({ id: petCaretakerGrants.id });
  byAccountGrantId = byAccount.id;

  // Grant 2 — a THIRD PARTY's pet, invitee identified BY EMAIL ONLY. This is the
  // shape the erase path can only reach through the email, and the one the
  // statement ordering in 0205 protects.
  const [byEmail] = await db
    .insert(petCaretakerGrants)
    .values({
      publicToken: `CUI-0205B-${stamp}`,
      petId: otherPetId,
      grantedByUserId: otherOwnerUserId,
      caretakerUserId: null,
      caretakerEmail: INVITEE_EMAIL.toUpperCase(), // stored mixed-case on purpose
      status: "pending",
      endsAt: inSevenDays,
      note: "Le dejo la llave a la vecina.",
    })
    .returning({ id: petCaretakerGrants.id });
  byEmailGrantId = byEmail.id;

  await db.insert(fosterVolunteers).values({
    userId: grantorUserId,
    status: "active",
    availableSlots: 1,
    jurisdictionProvince: "Buenos Aires",
    jurisdictionLocality: "La Plata",
    acceptsDogs: true,
    notes: "Tengo patio y dos perros propios.",
  });

  await db.insert(pushSubscriptions).values({
    userId: grantorUserId,
    endpoint: `https://push.sr0205.local/${stamp}`,
    p256dh: "p256dh-secret-value",
    auth: "auth-secret-value",
  });

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: `ORG-SR0205-${stamp}`,
      legalName: "Refugio Subject Rights 0205",
      displayName: "Refugio SR0205",
      orgType: "shelter",
      email: "sr0205-org@dim-test.local",
    })
    .returning({ id: organizations.id });
  orgId = org.id;

  const [msg] = await db
    .insert(orgContactMessages)
    .values({
      organizationId: orgId,
      inquirerEmail: GRANTOR_EMAIL,
      inquirerName: "Titular Cero Doscientos Cinco",
      message: "Vivo en Calle Falsa 123 y quiero adoptar.",
      submitterIp: "203.0.113.44",
    })
    .returning({ id: orgContactMessages.id });
  contactMessageId = msg.id;
}, 30_000);

afterAll(async () => {
  await purge();
}, 30_000);

describe("export_subject_data — the four sections migration 0205 added (art. 14)", () => {
  it("returns grants, foster enrolment, contact messages and push registrations at schema_version 5", async () => {
    const { data, error } = await callRpcAs<Record<string, unknown>>(
      grantorUserId,
      sql`SELECT public.export_subject_data(${grantorUserId}::uuid)`,
    );
    expect(error).toBeNull();
    const payload = data as {
      schema_version: number;
      pet_caretaker_grants: Array<Record<string, unknown>>;
      foster_volunteers: Array<Record<string, unknown>>;
      org_contact_messages: Array<Record<string, unknown>>;
      push_subscriptions: Array<Record<string, unknown>>;
    };

    // 0208 bumped 4 -> 5 when it added operator_feed_watermarks,
    // physical_tag_interest and organization_invitations.
    expect(payload.schema_version).toBe(5);
    expect(payload.pet_caretaker_grants.map((g) => g.id)).toContain(byAccountGrantId);
    expect(payload.foster_volunteers).toHaveLength(1);
    expect(payload.foster_volunteers[0].notes).toBe("Tengo patio y dos perros propios.");
    expect(payload.org_contact_messages.map((m) => m.id)).toContain(contactMessageId);
    expect(payload.push_subscriptions).toHaveLength(1);
  });

  it("NEVER hands back the push encryption keys — the same exclusion 0170 made for activation_code_hash", async () => {
    const { data } = await callRpcAs<Record<string, unknown>>(
      grantorUserId,
      sql`SELECT public.export_subject_data(${grantorUserId}::uuid)`,
    );
    const payload = data as { push_subscriptions: Array<Record<string, unknown>> };
    for (const row of payload.push_subscriptions) {
      expect(row).not.toHaveProperty("p256dh");
      expect(row).not.toHaveProperty("auth");
      // The endpoint stays: without the two keys above it cannot deliver
      // anything a browser will accept (RFC 8291).
      expect(row).toHaveProperty("endpoint");
    }
    // Belt-and-suspenders: neither secret appears anywhere in the whole blob.
    const blob = JSON.stringify(data);
    expect(blob).not.toContain("p256dh-secret-value");
    expect(blob).not.toContain("auth-secret-value");
  });

  it("reaches a grant addressed to the subject BY EMAIL, with no account link", async () => {
    const { data } = await callRpcAs<Record<string, unknown>>(
      inviteeUserId,
      sql`SELECT public.export_subject_data(${inviteeUserId}::uuid)`,
    );
    const payload = data as { pet_caretaker_grants: Array<Record<string, unknown>> };
    const ids = payload.pet_caretaker_grants.map((g) => g.id);
    expect(ids).toContain(byAccountGrantId); // by caretaker_user_id
    expect(ids).toContain(byEmailGrantId); // by lower(caretaker_email) — mixed case in the row
  });
});

describe("erase_subject_data — the GRANTOR side (art. 16)", () => {
  it("cancels the pending invitation, drops the note, and LEAVES the third party's email alone", async () => {
    const { error } = await callRpcAs<null>(
      grantorUserId,
      sql`SELECT public.erase_subject_data(${grantorUserId}::uuid, ${"test erasure 0205 grantor"})`,
    );
    expect(error).toBeNull();

    const row = await grantRow(byAccountGrantId);
    expect(row.status).toBe("cancelled");
    expect(row.respondedAt).not.toBeNull();
    expect(row.note).toBeNull();
    // THE DECISION THIS PINS: where the subject is the GRANTOR, caretaker_email
    // is the address of somebody ELSE. Erasing the grantor may not erase it.
    expect(row.caretakerEmail).toBe(INVITEE_EMAIL);
  });

  it("deletes the foster enrolment outright and nulls the account jurisdiction", async () => {
    const foster = await db
      .select({ id: fosterVolunteers.id })
      .from(fosterVolunteers)
      .where(eq(fosterVolunteers.userId, grantorUserId));
    expect(foster).toHaveLength(0);

    const [profile] = await db
      .select({
        province: profiles.jurisdictionProvince,
        locality: profiles.jurisdictionLocality,
      })
      .from(profiles)
      .where(eq(profiles.id, grantorUserId));
    expect(profile.province).toBeNull();
    expect(profile.locality).toBeNull();
  });

  // THE THIRD PARTY THIS PINS. `ownerships` keeps closed rows forever, so any
  // predicate that forgets `ended_at IS NULL` reaches every pet the subject EVER
  // owned — including one they transferred away, whose contact fields now belong
  // to the person who bought it. An adversarial review found exactly that in the
  // C2 backfill of 0205 before the file ran anywhere real; the live RPC always
  // had the filter, and this is what stops a future edit from dropping it.
  it("LEAVES ALONE a pet the subject transferred away — those fields are the new owner's", async () => {
    const [pet] = await db
      .select({
        emergencyContactName: pets.emergencyContactName,
        preferredVetName: pets.preferredVetName,
        insuranceCompany: pets.insuranceCompany,
        deletedAt: pets.deletedAt,
      })
      .from(pets)
      .where(eq(pets.id, transferredPetId));
    expect(pet.emergencyContactName).toBe("Vecina Marta");
    expect(pet.preferredVetName).toBe("Dr. Quiroga");
    expect(pet.insuranceCompany).toBe("Mascota Segura SA");
    // And it is not soft-deleted either: the pets soft-delete carries the same
    // `ended_at IS NULL` scoping, for the same reason.
    expect(pet.deletedAt).toBeNull();

    // NON-VACUITY. The assertions above would also pass on a fixture where no
    // predicate could ever have reached this pet, which would make them decoration.
    // So run the WIDE predicate — the one 0205's C2 backfill carried before the
    // review — and prove it DOES select this row. Narrow spares it, wide takes it:
    // the difference is real on this fixture, and that is what the test pins.
    const wide = (await db.execute(sql`
      SELECT count(*)::int AS n
        FROM public.pets p
       WHERE p.id = ${transferredPetId}
         AND EXISTS (
               SELECT 1 FROM public.ownerships o
                 JOIN public.profiles pr ON pr.id = o.owner_user_id
                WHERE o.pet_id = p.id AND o.role = 'owner'
                  AND pr.deleted_at IS NOT NULL
             )
    `)) as unknown as Array<{ n: number }>;
    expect(wide[0].n).toBe(1);

    const narrow = (await db.execute(sql`
      SELECT count(*)::int AS n
        FROM public.pets p
       WHERE p.id = ${transferredPetId}
         AND EXISTS (
               SELECT 1 FROM public.ownerships o
                 JOIN public.profiles pr ON pr.id = o.owner_user_id
                WHERE o.pet_id = p.id AND o.role = 'owner' AND o.ended_at IS NULL
                  AND pr.deleted_at IS NOT NULL
             )
    `)) as unknown as Array<{ n: number }>;
    expect(narrow[0].n).toBe(0);
  });

  it("scrubs the PER-PET mirrors of the profile contact fields", async () => {
    const [pet] = await db
      .select({
        emergencyContactName: pets.emergencyContactName,
        emergencyContactPhone: pets.emergencyContactPhone,
        preferredVetName: pets.preferredVetName,
        preferredVetPhone: pets.preferredVetPhone,
        insuranceCompany: pets.insuranceCompany,
        insurancePolicyNumber: pets.insurancePolicyNumber,
      })
      .from(pets)
      .where(eq(pets.id, grantorPetId));
    expect(pet.emergencyContactName).toBeNull();
    expect(pet.emergencyContactPhone).toBeNull();
    expect(pet.preferredVetName).toBeNull();
    expect(pet.preferredVetPhone).toBeNull();
    expect(pet.insuranceCompany).toBeNull();
    expect(pet.insurancePolicyNumber).toBeNull();
  });

  it("drops the raw IP and the body of the contact message, and keeps the row", async () => {
    const [msg] = await db
      .select({
        inquirerEmail: orgContactMessages.inquirerEmail,
        inquirerName: orgContactMessages.inquirerName,
        message: orgContactMessages.message,
        submitterIp: orgContactMessages.submitterIp,
        organizationId: orgContactMessages.organizationId,
      })
      .from(orgContactMessages)
      .where(eq(orgContactMessages.id, contactMessageId));
    expect(msg.inquirerEmail).toBe(ERASED_SENTINEL);
    expect(msg.inquirerName).toBeNull();
    expect(msg.message).toBe(REDACTED);
    expect(msg.submitterIp).toBeNull();
    // The row itself is the organization's record that a message arrived.
    expect(msg.organizationId).toBe(orgId);
  });

  it("counts every new scrub in the subject_erasure audit payload", async () => {
    const payload = await latestErasurePayload(grantorUserId);
    expect(payload.grants_grantor_cancelled).toBe(1);
    expect(payload.grants_note_scrubbed).toBe(1);
    expect(payload.grants_email_scrubbed).toBe(0); // grantor side never touches it
    expect(payload.foster_volunteers_deleted).toBe(1);
    expect(payload.pets_contact_scrubbed).toBe(1);
    expect(payload.contact_messages_scrubbed).toBe(1);
  });

  it("is IDEMPOTENT: a second run finds nothing and counts zero", async () => {
    const { error } = await callRpcAs<null>(
      grantorUserId,
      sql`SELECT public.erase_subject_data(${grantorUserId}::uuid, ${"test erasure 0205 re-run"})`,
    );
    expect(error).toBeNull();
    const payload = await latestErasurePayload(grantorUserId);
    expect(payload.grants_grantor_cancelled).toBe(0);
    expect(payload.grants_note_scrubbed).toBe(0);
    expect(payload.foster_volunteers_deleted).toBe(0);
    expect(payload.pets_contact_scrubbed).toBe(0);
    expect(payload.contact_messages_scrubbed).toBe(0);
  });
});

describe("erase_subject_data — the INVITEE side (art. 16)", () => {
  it("rejects the pending invitation reached BY EMAIL and sentinels the address on every status", async () => {
    const { error } = await callRpcAs<null>(
      inviteeUserId,
      sql`SELECT public.erase_subject_data(${inviteeUserId}::uuid, ${"test erasure 0205 invitee"})`,
    );
    expect(error).toBeNull();

    // Reached only through lower(caretaker_email) — this row has no
    // caretaker_user_id at all. If the sentinel ever runs BEFORE the flip, this
    // stays 'pending' forever and the assertion below is what says so.
    const byEmail = await grantRow(byEmailGrantId);
    expect(byEmail.status).toBe("rejected");
    expect(byEmail.respondedAt).not.toBeNull();
    expect(byEmail.caretakerEmail).toBe(ERASED_SENTINEL);
    expect(byEmail.caretakerUserId).toBeNull();

    // The already-cancelled grant keeps its status but loses the address: the
    // sentinel is not scoped to pending rows.
    const byAccount = await grantRow(byAccountGrantId);
    expect(byAccount.status).toBe("cancelled");
    expect(byAccount.caretakerEmail).toBe(ERASED_SENTINEL);

    const payload = await latestErasurePayload(inviteeUserId);
    expect(payload.grants_invitee_rejected).toBe(1);
    expect(payload.grants_email_scrubbed).toBe(2);
  });

  it("is IDEMPOTENT on the invitee side too", async () => {
    const { error } = await callRpcAs<null>(
      inviteeUserId,
      sql`SELECT public.erase_subject_data(${inviteeUserId}::uuid, ${"test erasure 0205 invitee re-run"})`,
    );
    expect(error).toBeNull();
    const payload = await latestErasurePayload(inviteeUserId);
    expect(payload.grants_invitee_rejected).toBe(0);
    expect(payload.grants_email_scrubbed).toBe(0);
  });
});
