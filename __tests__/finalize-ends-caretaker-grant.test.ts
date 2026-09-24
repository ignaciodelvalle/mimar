// Regression fence: a custody hand-off must not leave a caretaker grant open.
//
// THE BUG THIS EXISTS FOR
// ---------------------------------------------------------------------------
// `insertAdoptionFinalized` closed every live ownership row with one blanket
// `UPDATE ownerships SET ended_at = now WHERE pet_id = ? AND ended_at IS NULL`.
// That is correct for owner, co_owner, foster and shelter_custody — one row
// each. It is NOT correct for `caretaker`, which is three writes that belong
// together: close the row, emit `caretaker_ended`, flip
// `pet_caretaker_grants.status` to 'ended'. The blanket UPDATE did the first
// and skipped the other two, leaving a grant that says 'accepted' pointing at
// a closed ownership row.
//
// The zombie grant is not inert. `caretaker-public-contact.ts` decides the
// public lost-mode disclosure from the GRANT ALONE — status='accepted',
// ends_at in the future, two consent flags — and never joins `ownerships`. So
// the previous caretaker's first name and phone keep appearing on the ADOPTER'S
// public credential until ends_at, for an arrangement that ended the day the
// animal changed hands. `execute-decomiso.ts` had the same shape.
//
// WHY THIS TEST HITS REAL POSTGRES (the `db` vitest project, serial)
// ---------------------------------------------------------------------------
// The claim is about what rows and events survive a real transaction across
// three tables. A mocked repository would assert that the code I just wrote
// calls the function I just wrote, which proves nothing about the grant.
//
// The first `it` is the NON-VACUITY CONTROL: it proves the grant was live and
// accepted going in. Without it, a fixture that silently failed to create the
// grant would make every assertion below pass against the broken code.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  db,
  notifications,
  organizationMemberships,
  organizations,
  ownerships,
  petCaretakerGrants,
  petEvents,
  pets,
  profiles,
} from "@/db";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { resolveCaretakerPublicContact } from "@/lib/infra/caretaker-public-contact";
import { dniLast4, hashDni } from "@/lib/utils/dni-hash";
import { finalizeAdoption } from "@/src/modules/adoption/application/finalize-adoption";
import { AdoptionRepository } from "@/src/modules/adoption/infrastructure/adoption-repository";

import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const supabaseAdmin = createSupabaseClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const TITULAR_EMAIL = "ctkzombie-titular@dim-test.local";
const CARETAKER_EMAIL = "ctkzombie-caretaker@dim-test.local";
const ADOPTER_EMAIL = "ctkzombie-adopter@dim-test.local";
const COORD_EMAIL = "ctkzombie-coord@dim-test.local";
const PASS = "CtkZombie_2026!";

const ORG_TOKEN = "DIM-CTKZ-ORG1";
const PET_TOKEN = "DIM-CTKZ-PET1";
const GRANT_TOKEN = "DIM-CTKZ-GRANT1";
const ADOPTER_DNI = "30777441";

let titularUserId: string;
let caretakerUserId: string;
let adopterUserId: string;
let coordUserId: string;
let orgId: string;
let petId: string;
let grantId: string;
let caretakerOwnershipId: string;

// The caretaker arrangement is still running when the adoption finalizes: that
// is the whole point. An `ends_at` in the past would have the daily expiry cron
// as an alternative explanation for a flipped grant, and the test would no
// longer be about finalize.
const GRANT_ENDS_AT = new Date("2027-06-30T12:00:00Z");

async function purgeUserByEmail(email: string): Promise<void> {
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
  await withMutationOverride(async (tx) => {
    for (const uid of ids) {
      await tx.delete(notifications).where(eq(notifications.userId, uid));
      await tx.delete(organizationMemberships).where(eq(organizationMemberships.userId, uid));
      await tx.delete(ownerships).where(eq(ownerships.ownerUserId, uid));
      await tx.delete(profiles).where(eq(profiles.id, uid));
    }
  });
  if (found) await supabaseAdmin.auth.admin.deleteUser(found.id);
}

beforeAll(async () => {
  // Leftovers from a crashed previous run — the tokens are hardcoded.
  await withMutationOverride(async (tx) => {
    const stalePets = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(eq(pets.publicToken, PET_TOKEN));
    for (const { id } of stalePets) {
      await tx.delete(notifications).where(eq(notifications.relatedPetId, id));
      await tx.delete(petCaretakerGrants).where(eq(petCaretakerGrants.petId, id));
      await tx.delete(ownerships).where(eq(ownerships.petId, id));
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  });
  const staleOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, ORG_TOKEN));
  for (const { id } of staleOrgs) {
    await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, id));
    await db.delete(organizations).where(eq(organizations.id, id));
  }
  for (const email of [TITULAR_EMAIL, CARETAKER_EMAIL, ADOPTER_EMAIL, COORD_EMAIL]) {
    await purgeUserByEmail(email);
  }

  for (const { email, ref } of [
    { email: TITULAR_EMAIL, ref: "titular" },
    { email: CARETAKER_EMAIL, ref: "caretaker" },
    { email: ADOPTER_EMAIL, ref: "adopter" },
    { email: COORD_EMAIL, ref: "coord" },
  ] as const) {
    const r = await createFreshTestUser(supabaseAdmin, {
      email,
      password: PASS,
      email_confirm: true,
    });
    if (r.error || !r.data.user) throw new Error(`createUser ${ref}: ${r.error?.message}`);
    if (ref === "titular") titularUserId = r.data.user.id;
    if (ref === "caretaker") caretakerUserId = r.data.user.id;
    if (ref === "adopter") adopterUserId = r.data.user.id;
    if (ref === "coord") coordUserId = r.data.user.id;
  }

  await db
    .update(profiles)
    .set({ displayName: "Ctkzombie Titular", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, titularUserId));
  await db
    .update(profiles)
    .set({
      displayName: "Ctkzombie Caretaker",
      phone: "+541133330441",
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, caretakerUserId));
  // The adopter is resolved by the manual-DNI branch of finalize-adoption,
  // which requires a real registered account.
  await db
    .update(profiles)
    .set({
      displayName: "Ctkzombie Adopter",
      phone: "+541133330442",
      dniHash: hashDni(ADOPTER_DNI),
      dniLast4: dniLast4(ADOPTER_DNI),
      dniVerified: true,
      role: "owner",
      accountType: "personal",
    })
    .where(eq(profiles.id, adopterUserId));
  await db
    .update(profiles)
    .set({ displayName: "Ctkzombie Coord", role: "owner", accountType: "personal" })
    .where(eq(profiles.id, coordUserId));

  const [org] = await db
    .insert(organizations)
    .values({
      publicToken: ORG_TOKEN,
      legalName: "Ctkzombie Refugio SRL",
      displayName: "Refugio Ctkzombie",
      orgType: "shelter",
      email: "ctkzombie-org@dim-test.local",
      verified: true,
    })
    .returning();
  orgId = org.id;

  await db.insert(organizationMemberships).values({
    organizationId: orgId,
    userId: coordUserId,
    role: "admin",
    canWritePetEvents: true,
  });

  const now = new Date();
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Rulo",
      species: "dog",
      sex: "male",
      potentiallyDangerousBreed: false,
      adoptionListedAt: now,
      adoptionEligible: true,
      adoptionEligibilitySetAt: now,
      inCustodyDispute: false,
      rabiesObservationStatus: null,
      // KEY 1 of the two-key public-disclosure model, the titular's. Set here
      // ON PURPOSE and not as fixture noise: with key 1 off,
      // `resolveCaretakerPublicContact` returns null for every input and the
      // leak assertion below would pass against the broken code too. The whole
      // motivation for this fence is the configuration in which the zombie
      // grant actually publishes a stranger's phone, and this is that
      // configuration.
      discloseCaretakerContactWhenLost: true,
    })
    .returning();
  petId = pet.id;

  // THE SHAPE UNDER TEST, and it is not exotic: the titular keeps the title
  // while a verified org runs the adoption (rehome-by-titular), and a third
  // person is physically looking after the animal in the meantime. Three live
  // ownership rows, one of which is a caretaker.
  await db
    .insert(ownerships)
    .values({ petId, ownerUserId: titularUserId, role: "owner", startedAt: now });

  const [sponsorRow] = await db
    .insert(ownerships)
    .values({ petId, ownerOrganizationId: orgId, role: "shelter_custody", startedAt: now })
    .returning({ id: ownerships.id });

  const [caretakerRow] = await db
    .insert(ownerships)
    .values({ petId, ownerUserId: caretakerUserId, role: "caretaker", startedAt: now })
    .returning({ id: ownerships.id });
  caretakerOwnershipId = caretakerRow.id;

  const [grant] = await db
    .insert(petCaretakerGrants)
    .values({
      publicToken: GRANT_TOKEN,
      petId,
      grantedByUserId: titularUserId,
      caretakerUserId,
      caretakerEmail: CARETAKER_EMAIL,
      status: "accepted",
      startsAt: now,
      endsAt: GRANT_ENDS_AT,
      respondedAt: now,
      ownershipId: caretakerOwnershipId,
      // KEY 2, the caretaker's own consent. Together with
      // `discloseCaretakerContactWhenLost` on the pet above, this is the exact
      // configuration under which the leak is observable.
      publicContactConsentAt: now,
    })
    .returning({ id: petCaretakerGrants.id });
  grantId = grant.id;

  await db.insert(petEvents).values({
    petId,
    eventType: "caretaker_designated",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: titularUserId,
    authorRole: "owner",
    payload: validateEventPayload("caretaker_designated", {
      payload_version: 1,
      grant_id: grantId,
      grant_public_token: GRANT_TOKEN,
      caretaker_user_id: caretakerUserId,
      ends_at: GRANT_ENDS_AT.toISOString(),
      note: null,
    }),
  });

  await db.insert(petEvents).values({
    petId,
    eventType: "rehome_sponsorship_started",
    occurredAt: now,
    recordedAt: now,
    recordedByUserId: titularUserId,
    authorRole: "owner",
    payload: validateEventPayload("rehome_sponsorship_started", {
      ownership_id: sponsorRow.id,
      sponsoring_organization_id: orgId,
      consented_by_user_id: titularUserId,
      request_case_public_code: "CAS-CTKZ-0001",
      listing_case_id: null,
      note: null,
    }),
  });
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.relatedPetId, petId));
  await db.delete(petCaretakerGrants).where(eq(petCaretakerGrants.petId, petId));
  await db.delete(ownerships).where(eq(ownerships.petId, petId));
  await withMutationOverride(async (tx) => {
    await tx.delete(petEvents).where(eq(petEvents.petId, petId));
    await tx.delete(pets).where(eq(pets.id, petId));
  });
  await db.delete(organizationMemberships).where(eq(organizationMemberships.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  for (const email of [TITULAR_EMAIL, CARETAKER_EMAIL, ADOPTER_EMAIL, COORD_EMAIL]) {
    await purgeUserByEmail(email);
  }
});

// TEST ORDER IS LOAD-BEARING. The control needs the arrangement still live and
// the finalize consumes it. Vitest runs `it` blocks in declaration order inside
// a file; do not move the finalize case above the control.
describe("finalize over a caretaker — the control", () => {
  it("goes in with a live caretaker row and an accepted grant", async () => {
    const [row] = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "caretaker"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(row?.id).toBe(caretakerOwnershipId);

    const [g] = await db
      .select({ status: petCaretakerGrants.status, endedAt: petCaretakerGrants.endedAt })
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grantId));
    expect(g.status).toBe("accepted");
    expect(g.endedAt).toBeNull();
  });

  // THE LEAK, OBSERVED BEFORE THE FIX RUNS. Without this the "returns null
  // after finalize" assertion below is untrustworthy: a fixture that failed to
  // arm either consent key would make it pass no matter what finalize did.
  it("publishes the caretaker's contact on the public credential while the arrangement is live", async () => {
    const contact = await resolveCaretakerPublicContact({ petId });
    expect(contact).not.toBeNull();
    expect(contact?.firstName).toBe("Ctkzombie");
    expect(contact?.phoneE164).toBe("+541133330441");
  });
});

describe("finalize over a caretaker — the arrangement ends with the hand-off", () => {
  it("closes the row, flips the grant and writes caretaker_ended", async () => {
    const result = await finalizeAdoption(
      {
        petPublicToken: PET_TOKEN,
        applicationEventId: null,
        adopterUserId: null,
        adopterDni: ADOPTER_DNI,
        adopterDisplayName: "Ctkzombie Adopter",
        adopterPhone: "+541133330442",
        followupMonths: 0,
        notes: "Finalize sobre una mascota con cuidador temporal vivo",
        contractAttachmentId: null,
        contractStoragePath: null,
        contractMimeType: null,
        contractFileSize: null,
      },
      {
        repo: AdoptionRepository,
        actor: {
          user: { id: coordUserId },
          organization: {
            id: orgId,
            publicToken: ORG_TOKEN,
            verified: true,
            displayName: "Refugio Ctkzombie",
          },
        },
        transaction: db.transaction.bind(db),
      },
    );

    expect(result.ok, `finalize falló: ${result.ok ? "" : result.error}`).toBe(true);

    // 1. The ownership row is closed. The blanket UPDATE already did this one,
    //    which is exactly why the other two assertions are the real test.
    const liveCaretakerRows = await db
      .select({ id: ownerships.id })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          eq(ownerships.role, "caretaker"),
          isNull(ownerships.endedAt),
        ),
      );
    expect(liveCaretakerRows).toHaveLength(0);

    // 2. The grant is no longer accepted. THIS is what kept publishing the
    //    caretaker's phone on the adopter's public credential.
    const [g] = await db
      .select({
        status: petCaretakerGrants.status,
        endedReason: petCaretakerGrants.endedReason,
        endedAt: petCaretakerGrants.endedAt,
        ownershipId: petCaretakerGrants.ownershipId,
      })
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.id, grantId));
    expect(g.status).toBe("ended");
    expect(g.endedAt).not.toBeNull();
    // Not `returned`, not `expired`: the animal did not come back and the clock
    // did not run out. Titularity moved. The outcome drives the caretaker's own
    // notification copy, so an approximate value here is a wrong sentence in
    // someone's inbox.
    expect(g.endedReason).toBe("ownership_transferred");
    // The pointer survives on purpose — it is what lets the drift harness match
    // the grant to the row it produced after the arrangement is over.
    expect(g.ownershipId).toBe(caretakerOwnershipId);

    // 3. The spine says so. Under invariant 2 the grant flip is a cache; the
    //    event is the fact, and without it a rederive would resurrect the grant.
    const ended = await db
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "caretaker_ended")));
    expect(ended).toHaveLength(1);
    expect((ended[0].payload as { grant_id: string }).grant_id).toBe(grantId);
    expect((ended[0].payload as { outcome: string }).outcome).toBe("ownership_transferred");

    // 4. AND THE LEAK IS CLOSED — the point of the whole exercise. The three
    //    assertions above are about rows; this one is about what a stranger
    //    scanning the adopter's QR can read. The control above proved this
    //    returned a real name and phone moments ago.
    const contactAfter = await resolveCaretakerPublicContact({ petId });
    expect(contactAfter).toBeNull();
  });

  it("signs caretaker_ended as the organisation, not as the owner", async () => {
    // The refugio coordinator ran this finalize. Signed "owner"/unverified, the
    // ADOPTER's timeline would render "Cuidado temporal finalizado — Dueño/a,
    // no verificado" for an event they had nothing to do with. db/schema.ts:
    // "the test is who the author IS, not which event type they reached for".
    const [ended] = await db
      .select({
        authorRole: petEvents.authorRole,
        authorVerified: petEvents.authorVerified,
        authorOrganizationId: petEvents.authorOrganizationId,
      })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "caretaker_ended")));
    expect(ended.authorRole).toBe("shelter");
    expect(ended.authorVerified).toBe(true);
    expect(ended.authorOrganizationId).toBe(orgId);
  });

  it("tells the caretaker their arrangement ended, exactly once", async () => {
    // They lost write access and the pet vanished from their list. Nothing else
    // tells them, and they may still physically have the animal. The dedupe key
    // is the same family the expiry cron uses, so a later cron pass cannot
    // produce a second copy.
    const rows = await db
      .select({
        dedupeKey: notifications.dedupeKey,
        body: notifications.body,
        ctaUrl: notifications.ctaUrl,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, caretakerUserId),
          eq(notifications.notificationType, "caretaker_grant_ended"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(`caretaker:grant_ended:${grantId}:${caretakerUserId}`);
    expect(rows[0].body).toContain("cambió la titularidad");
    // PO decision 4A: a next step they can actually take — the person who left
    // the animal with them, by the means they already used, or the platform —
    // never "coordiná con quien lo tiene a cargo ahora", a stranger they cannot
    // reach.
    expect(rows[0].body).toContain("avisale a quien te lo dejó a cargo por el medio que ya usaban");
    expect(rows[0].body).toContain("escribinos");
    expect(rows[0].body).not.toContain("quien lo tiene a cargo ahora");
    expect(rows[0].ctaUrl).toBe("/sugerencias");
  });

  it("leaves the adopter as the only live owner", async () => {
    const liveOwners = await db
      .select({ ownerUserId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(eq(ownerships.petId, petId), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
      );
    expect(liveOwners).toHaveLength(1);
    expect(liveOwners[0].ownerUserId).toBe(adopterUserId);
  });
});
