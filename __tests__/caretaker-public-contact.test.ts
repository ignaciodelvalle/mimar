// The two-key gate on publishing a caretaker's contact to an unauthenticated page.
//
// THE INVARIANT WORTH PINNING IS "NEVER BY DEFAULT". The spec originally said
// the public credential must NEVER reference the caretaker; the PO decision of
// 2026-08-19 amended that to "never UNLESS both keys are set", and the right
// response to an amendment like that is to keep the old assertion and add the
// narrow path — not to delete it. Every combination below is enumerated, and
// the only one that discloses anything is the one where BOTH keys hold.
//
// Key 1 is the TITULAR's: `pets.disclose_caretaker_contact_when_lost`, off by
// default like its disclosure siblings.
// Key 2 is the CARETAKER's: `pet_caretaker_grants.public_contact_consent_at`,
// captured at accept. Publishing a third party's phone number on a page anyone
// can open is not a consent the titular is able to give on their behalf.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, ownerships, petCaretakerGrants, pets, profiles } from "@/db";
import { resolveCaretakerPublicContact } from "@/lib/infra/caretaker-public-contact";

const PET_TOKEN = "DIM-CPUB-0001";
const TITULAR_ID = "0cae7a14-4444-4000-8000-000000000001";
const CARETAKER_ID = "0cae7a14-4444-4000-8000-000000000002";

const NOW = new Date("2026-09-01T12:00:00Z");
const ENDS_AT = new Date("2026-09-15T00:00:00Z");

let petId: string;
let ownershipId: string;

async function cleanup(): Promise<void> {
  await db.execute(
    sql`DELETE FROM pet_caretaker_grants WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CARETAKER_ID}::uuid)`,
  );
}

/** An ACCEPTED grant, with or without the caretaker's consent. */
async function seedAcceptedGrant(consented: boolean, endsAt = ENDS_AT): Promise<void> {
  await db.insert(petCaretakerGrants).values({
    publicToken: `CG-${consented ? "yes" : "no"}-${Date.now()}`,
    petId,
    grantedByUserId: TITULAR_ID,
    caretakerUserId: CARETAKER_ID,
    caretakerEmail: "ana@example.com",
    status: "accepted",
    startsAt: new Date("2026-08-20T00:00:00Z"),
    endsAt,
    ownershipId,
    publicContactConsentAt: consented ? new Date("2026-08-20T10:00:00Z") : null,
  });
}

async function setKey1(on: boolean): Promise<void> {
  await db.update(pets).set({ discloseCaretakerContactWhenLost: on }).where(eq(pets.id, petId));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Ignacio Del Valle", role: "owner", phone: "+541155550000" },
    { id: CARETAKER_ID, displayName: "Ana Pérez López", role: "owner", phone: "+541155550001" },
  ]);
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa Pública", species: "dog", status: "lost" })
    .returning({ id: pets.id });
  petId = pet.id;
  await db.insert(ownerships).values({ petId, ownerUserId: TITULAR_ID, role: "owner" });
  const [own] = await db
    .insert(ownerships)
    .values({ petId, ownerUserId: CARETAKER_ID, role: "caretaker" })
    .returning({ id: ownerships.id });
  ownershipId = own.id;
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM pet_caretaker_grants WHERE pet_id = ${petId}::uuid`);
  await setKey1(false);
});

afterAll(async () => {
  await cleanup();
});

describe("resolveCaretakerPublicContact — the default is silence", () => {
  it("discloses nothing when the pet has no caretaker at all", async () => {
    await setKey1(true);
    expect(await resolveCaretakerPublicContact({ petId, now: NOW })).toBeNull();
  });

  it("discloses nothing with a caretaker but NEITHER key", async () => {
    await seedAcceptedGrant(false);
    expect(await resolveCaretakerPublicContact({ petId, now: NOW })).toBeNull();
  });

  it("discloses nothing with the titular's key alone (key 2 missing)", async () => {
    // The reason key 2 exists. The titular flipping their own toggle must never
    // be enough to publish somebody else's phone number.
    await seedAcceptedGrant(false);
    await setKey1(true);
    expect(await resolveCaretakerPublicContact({ petId, now: NOW })).toBeNull();
  });

  it("discloses nothing with the caretaker's key alone (key 1 missing)", async () => {
    // Consent is not a request. The caretaker agreeing that their contact MAY
    // be published does not publish it; the titular still decides.
    await seedAcceptedGrant(true);
    expect(await resolveCaretakerPublicContact({ petId, now: NOW })).toBeNull();
  });
});

describe("resolveCaretakerPublicContact — both keys", () => {
  it("discloses the caretaker's FIRST name and phone when both keys are set", async () => {
    await seedAcceptedGrant(true);
    await setKey1(true);

    const contact = await resolveCaretakerPublicContact({ petId, now: NOW });

    // First name only, the same rule the titular's own disclosure follows: a
    // public credential never carries a full legal name.
    expect(contact).toEqual({ firstName: "Ana", phoneE164: "+541155550001" });
  });

  it("discloses the name with a null phone when the caretaker has no phone on file", async () => {
    await db.update(profiles).set({ phone: null }).where(eq(profiles.id, CARETAKER_ID));
    await seedAcceptedGrant(true);
    await setKey1(true);

    const contact = await resolveCaretakerPublicContact({ petId, now: NOW });

    expect(contact).toEqual({ firstName: "Ana", phoneE164: null });

    await db.update(profiles).set({ phone: "+541155550001" }).where(eq(profiles.id, CARETAKER_ID));
  });
});

describe("resolveCaretakerPublicContact — the arrangement has to be live", () => {
  it("stops disclosing the moment the grant's period has passed", async () => {
    // The cron closes expired grants once a day. Between `ends_at` and the next
    // 04:00 run the row still says `accepted` — and a public page that keeps
    // publishing a stranger's phone for up to 24 hours after their arrangement
    // ended is the failure this check exists to prevent.
    await seedAcceptedGrant(true, new Date("2026-08-25T00:00:00Z"));
    await setKey1(true);

    expect(await resolveCaretakerPublicContact({ petId, now: NOW })).toBeNull();
  });

  it("stops disclosing once the grant is ENDED, consent record intact", async () => {
    await seedAcceptedGrant(true);
    await setKey1(true);
    await db
      .update(petCaretakerGrants)
      .set({ status: "ended", endedAt: NOW, endedReason: "revoked_by_owner" })
      .where(eq(petCaretakerGrants.petId, petId));

    expect(await resolveCaretakerPublicContact({ petId, now: NOW })).toBeNull();

    // The consent SURVIVES — it is a historical fact about what was agreed, not
    // a live permission flag. Erasing it on end would be rewriting the record.
    const [row] = await db
      .select()
      .from(petCaretakerGrants)
      .where(eq(petCaretakerGrants.petId, petId));
    expect(row.publicContactConsentAt).not.toBeNull();
  });

  it("discloses nothing for a PENDING invitation, even with key 1 on", async () => {
    await db.insert(petCaretakerGrants).values({
      publicToken: `CG-pending-${Date.now()}`,
      petId,
      grantedByUserId: TITULAR_ID,
      caretakerUserId: CARETAKER_ID,
      caretakerEmail: "ana@example.com",
      status: "pending",
      startsAt: new Date("2026-08-20T00:00:00Z"),
      endsAt: ENDS_AT,
    });
    await setKey1(true);

    expect(await resolveCaretakerPublicContact({ petId, now: NOW })).toBeNull();
  });
});
