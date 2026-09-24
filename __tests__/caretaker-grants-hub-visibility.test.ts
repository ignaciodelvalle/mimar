// `CaretakersRepository.listGrantsForUser` — the addressee predicate the NEW
// `/transferencias` hub sections (web AND mobile, T4-M4) run through, via
// `listCaretakerGrantsForUser`.
//
// WHY THIS FILE EXISTS. The SQL predicate in `listGrantsForUser` had never been
// exercised against a real Postgres before T4-M4: every existing caller of
// `listCaretakerGrantsForUser` (`GET /api/v1/me/caretaker-grants`,
// `__tests__/api-v1-me-caretaker-grants-route.test.ts`) stubs the repository, so
// what those tests prove is the id-or-email RULE over a fake, never the actual
// query. This hub is the first UI that puts the repository's real predicate in
// front of a viewer with no per-token secret to fall back on — the web/mobile
// pages read the whole list, not one row picked out by an unguessable
// `grantToken` — so its authorization now rests on this query alone.
//
// Covers:
//   1. An invitee resolved by e-mail sees their pending invitation.
//   2. An invitee resolved by caretaker_user_id sees theirs too (id beats email).
//   3. A STRANGER — same query, different caller — sees NEITHER (IDOR).
//   4. A REJECTED invitation is invisible to the invitee who declined it: the
//      hub these sections feed is OPEN-only by construction, which is what
//      makes "declining makes it disappear" true without a second filter in
//      the UI layer.
//
// Requires a live DB. Run with
// `pnpm test __tests__/caretaker-grants-hub-visibility.test.ts`.

import { eq, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, petCaretakerGrants, pets, profiles } from "@/db";
import { CaretakersRepository } from "@/src/modules/caretakers/infrastructure/caretakers-repository";
import { withMutationOverride } from "./_helpers/db-overrides";

// Two pets: `pet_caretaker_grants_one_pending_per_pet` allows at most one
// PENDING row per animal, and this fixture needs two (email-arm, id-arm).
const PET_TOKEN = "DIM-CGV-HUB-0001";
const PET_TOKEN_2 = "DIM-CGV-HUB-0002";

const GRANTER_ID = "00000000-0000-0000-0000-0000000b0001";
const INVITEE_ID = "00000000-0000-0000-0000-0000000b0002";
const STRANGER_ID = "00000000-0000-0000-0000-0000000b0003";

const INVITEE_EMAIL = "invitee-cgv-hub@dim-test.local";
const STRANGER_EMAIL = "stranger-cgv-hub@dim-test.local";
// Never resolved to an account — exercises the email-only arm of the predicate.
const UNRESOLVED_INVITEE_EMAIL = "unresolved-invitee-cgv-hub@dim-test.local";

const TOKEN_BY_EMAIL = "CG-hub-test-by-email-0001";
const TOKEN_BY_ID = "CG-hub-test-by-id-00002";
const TOKEN_REJECTED = "CG-hub-test-rejected-003";

let petId: string;
let petId2: string;

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx
      .delete(petCaretakerGrants)
      .where(
        or(
          eq(petCaretakerGrants.publicToken, TOKEN_BY_EMAIL),
          eq(petCaretakerGrants.publicToken, TOKEN_BY_ID),
          eq(petCaretakerGrants.publicToken, TOKEN_REJECTED),
        ),
      );
    for (const token of [PET_TOKEN, PET_TOKEN_2]) {
      const stalePets = await tx
        .select({ id: pets.id })
        .from(pets)
        .where(eq(pets.publicToken, token));
      for (const { id } of stalePets) {
        await tx.delete(petCaretakerGrants).where(eq(petCaretakerGrants.petId, id));
        await tx.delete(pets).where(eq(pets.id, id));
      }
    }
    await tx
      .delete(profiles)
      .where(
        or(eq(profiles.id, GRANTER_ID), eq(profiles.id, INVITEE_ID), eq(profiles.id, STRANGER_ID)),
      );
  });

  await db
    .insert(profiles)
    .values({ id: GRANTER_ID, displayName: "CGV-HUB-GRANTER" })
    .onConflictDoNothing({ target: profiles.id });
  await db
    .insert(profiles)
    .values({ id: INVITEE_ID, displayName: "CGV-HUB-INVITEE" })
    .onConflictDoNothing({ target: profiles.id });
  await db
    .insert(profiles)
    .values({ id: STRANGER_ID, displayName: "CGV-HUB-STRANGER" })
    .onConflictDoNothing({ target: profiles.id });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Hub Visibility Test Pet",
      species: "dog",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId = pet.id;

  // A second pet: `pet_caretaker_grants_one_pending_per_pet` allows only one
  // PENDING row per animal, and TOKEN_BY_EMAIL and TOKEN_BY_ID are both pending.
  const [pet2] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN_2,
      name: "Hub Visibility Test Pet 2",
      species: "cat",
      sex: "unknown",
      potentiallyDangerousBreed: false,
    })
    .returning();
  petId2 = pet2.id;

  const now = new Date();
  const startsAt = now;
  const endsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Row 1: PENDING, addressed by e-mail only (no account resolved at invite
  // time) — the email-only arm of `listGrantsForUser`'s predicate.
  await db.insert(petCaretakerGrants).values({
    publicToken: TOKEN_BY_EMAIL,
    petId,
    grantedByUserId: GRANTER_ID,
    caretakerUserId: null,
    caretakerEmail: UNRESOLVED_INVITEE_EMAIL,
    status: "pending",
    startsAt,
    endsAt,
  });

  // Row 2: PENDING, addressed by `caretaker_user_id` (the invitee already had
  // an account at invite time) — the id arm, which the predicate checks first.
  // On a SEPARATE pet — see the one-pending-per-pet note above.
  await db.insert(petCaretakerGrants).values({
    publicToken: TOKEN_BY_ID,
    petId: petId2,
    grantedByUserId: GRANTER_ID,
    caretakerUserId: INVITEE_ID,
    caretakerEmail: INVITEE_EMAIL,
    status: "pending",
    startsAt,
    endsAt,
  });

  // Row 3: REJECTED by the same invitee, on the SECOND pet — `rejected` is not
  // constrained by the one-pending-per-pet index. `listGrantsForUser` filters
  // to `status IN ('pending','accepted')`, so this row must never come back —
  // which is the whole mechanism behind "declining makes it disappear".
  await db.insert(petCaretakerGrants).values({
    publicToken: TOKEN_REJECTED,
    petId: petId2,
    grantedByUserId: GRANTER_ID,
    caretakerUserId: INVITEE_ID,
    caretakerEmail: INVITEE_EMAIL,
    status: "rejected",
    startsAt,
    endsAt,
    respondedAt: now,
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx
      .delete(petCaretakerGrants)
      .where(
        or(
          eq(petCaretakerGrants.publicToken, TOKEN_BY_EMAIL),
          eq(petCaretakerGrants.publicToken, TOKEN_BY_ID),
          eq(petCaretakerGrants.publicToken, TOKEN_REJECTED),
        ),
      );
    if (petId) await tx.delete(pets).where(eq(pets.id, petId));
    if (petId2) await tx.delete(pets).where(eq(pets.id, petId2));
    await tx
      .delete(profiles)
      .where(
        or(eq(profiles.id, GRANTER_ID), eq(profiles.id, INVITEE_ID), eq(profiles.id, STRANGER_ID)),
      );
  });
});

describe("CaretakersRepository.listGrantsForUser — hub visibility (T4-M4)", () => {
  it("the invitee sees their pending invitation, resolved by e-mail", async () => {
    const rows = await CaretakersRepository.listGrantsForUser({
      userId: "00000000-0000-0000-0000-0000000b0099", // no account for this address yet
      callerEmail: UNRESOLVED_INVITEE_EMAIL,
    });
    const tokens = rows.map((r) => r.grant.publicToken);
    expect(tokens).toContain(TOKEN_BY_EMAIL);
  });

  it("the invitee sees their pending invitation, resolved by caretaker_user_id", async () => {
    const rows = await CaretakersRepository.listGrantsForUser({
      userId: INVITEE_ID,
      callerEmail: INVITEE_EMAIL,
    });
    const tokens = rows.map((r) => r.grant.publicToken);
    expect(tokens).toContain(TOKEN_BY_ID);
  });

  it("IDOR: a stranger's own hub query does not return the invitee's invitation", async () => {
    const rows = await CaretakersRepository.listGrantsForUser({
      userId: STRANGER_ID,
      callerEmail: STRANGER_EMAIL,
    });
    const tokens = rows.map((r) => r.grant.publicToken);
    expect(tokens).not.toContain(TOKEN_BY_EMAIL);
    expect(tokens).not.toContain(TOKEN_BY_ID);
  });

  it("a rejected invitation never reaches the hub again — declining makes it disappear", async () => {
    const rows = await CaretakersRepository.listGrantsForUser({
      userId: INVITEE_ID,
      callerEmail: INVITEE_EMAIL,
    });
    const tokens = rows.map((r) => r.grant.publicToken);
    expect(tokens).not.toContain(TOKEN_REJECTED);
  });
});
