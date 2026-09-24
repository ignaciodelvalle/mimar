// "Ana registró el fallecimiento de Pampa."
//
// `death_recorded` is the ONE titular-only-looking event a caretaker is
// explicitly allowed to write (spec: "Allowed caretaker actions", and
// lib/domain/titular-only.ts names the exclusion out loud). It has to be
// allowed — the person holding the animal is the one who knows — and it is the
// single most consequential thing they can record: it closes the life record,
// flips `pets.status`, and cascades into fosters, custody episodes and rabies
// observation.
//
// The price of allowing it is that the titular MUST hear about it immediately.
// Not in a digest, not on their next login. That obligation is the whole
// content of this file.
//
// A `db` test on purpose: the recipient set is a JOIN over `ownerships` with a
// lifecycle filter, and the idempotency guarantee is an ON CONFLICT on a real
// unique index. Neither survives a mock.

import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, notifications, ownerships, pets, profiles } from "@/db";
import {
  announceCaretakerDeathRecord,
  notifyTitularOfCaretakerDeath,
} from "@/lib/infra/caretaker-activity-alert";

const PET_TOKEN = "DIM-CGDA-0001";
const TITULAR_ID = "0cae7a13-5555-4000-8000-000000000001";
const CO_OWNER_ID = "0cae7a13-5555-4000-8000-000000000002";
const CARETAKER_ID = "0cae7a13-5555-4000-8000-000000000003";
const EX_TITULAR_ID = "0cae7a13-5555-4000-8000-000000000004";
const EVENT_ID = "0cae7a13-5555-4000-8000-0000000000e1";

let petId: string;

async function clearNotifications(): Promise<void> {
  await db.execute(
    sql`DELETE FROM notifications WHERE user_id IN (${TITULAR_ID}::uuid, ${CO_OWNER_ID}::uuid, ${CARETAKER_ID}::uuid, ${EX_TITULAR_ID}::uuid)`,
  );
}

beforeAll(async () => {
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CO_OWNER_ID}::uuid, ${CARETAKER_ID}::uuid, ${EX_TITULAR_ID}::uuid)`,
  );

  await db.insert(profiles).values([
    { id: TITULAR_ID, displayName: "Ignacio", role: "owner" },
    { id: CO_OWNER_ID, displayName: "Sofía", role: "owner" },
    { id: CARETAKER_ID, displayName: "Ana", role: "owner" },
    { id: EX_TITULAR_ID, displayName: "Dueño Anterior", role: "owner" },
  ]);
  const [pet] = await db
    .insert(pets)
    .values({ publicToken: PET_TOKEN, name: "Pampa", species: "dog" })
    .returning({ id: pets.id });
  petId = pet.id;

  await db.insert(ownerships).values([
    { petId, ownerUserId: TITULAR_ID, role: "owner", startedAt: new Date("2026-01-01") },
    { petId, ownerUserId: CO_OWNER_ID, role: "co_owner", startedAt: new Date("2026-01-01") },
    { petId, ownerUserId: CARETAKER_ID, role: "caretaker", startedAt: new Date("2026-08-01") },
    {
      petId,
      ownerUserId: EX_TITULAR_ID,
      role: "owner",
      startedAt: new Date("2025-01-01"),
      endedAt: new Date("2026-01-01"),
    },
  ]);
});

afterEach(clearNotifications);

afterAll(async () => {
  await clearNotifications();
  await db.execute(
    sql`DELETE FROM ownerships WHERE pet_id IN (SELECT id FROM pets WHERE public_token = ${PET_TOKEN})`,
  );
  await db.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  await db.execute(
    sql`DELETE FROM profiles WHERE id IN (${TITULAR_ID}::uuid, ${CO_OWNER_ID}::uuid, ${CARETAKER_ID}::uuid, ${EX_TITULAR_ID}::uuid)`,
  );
});

function run() {
  return notifyTitularOfCaretakerDeath({
    petId,
    petName: "Pampa",
    petPublicToken: PET_TOKEN,
    caretakerUserId: CARETAKER_ID,
    eventId: EVENT_ID,
  });
}

async function notifiedUserIds(): Promise<string[]> {
  const rows = await db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.relatedPetId, petId));
  return rows.map((r) => r.userId).sort();
}

describe("notifyTitularOfCaretakerDeath", () => {
  it("writes the spec's sentence, verbatim", async () => {
    await run();
    const [row] = await db
      .select({ title: notifications.title })
      .from(notifications)
      .where(eq(notifications.userId, TITULAR_ID));
    expect(row?.title).toBe("Ana registró el fallecimiento de Pampa");
  });

  it("reaches the titular AND the co-owner — both hold titularidad", async () => {
    await run();
    expect(await notifiedUserIds()).toEqual([TITULAR_ID, CO_OWNER_ID].sort());
  });

  it("does not notify the caretaker about their own entry", async () => {
    await run();
    expect(await notifiedUserIds()).not.toContain(CARETAKER_ID);
  });

  it("does not notify a FORMER owner — their row ended", async () => {
    await run();
    expect(await notifiedUserIds()).not.toContain(EX_TITULAR_ID);
  });

  it("is urgent — this is not a digest item", async () => {
    await run();
    const [row] = await db
      .select({ severity: notifications.severity })
      .from(notifications)
      .where(eq(notifications.userId, TITULAR_ID));
    expect(row?.severity).toBe("urgent");
  });

  it("lands the owner on the pet, not on a generic list", async () => {
    await run();
    const [row] = await db
      .select({ ctaUrl: notifications.ctaUrl })
      .from(notifications)
      .where(eq(notifications.userId, TITULAR_ID));
    expect(row?.ctaUrl).toBe(`/mis-mascotas/${PET_TOKEN}`);
  });

  it("collapses on a retry — one death, one notice per person", async () => {
    // The action can be re-submitted and the death writer is idempotent, so
    // this must be too, or a grieving owner gets the same sentence twice.
    await run();
    await run();
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.userId, TITULAR_ID));
    expect(rows).toHaveLength(1);
  });

  it("says nothing and does not throw when nobody holds titularidad", async () => {
    // An org-held pet has `owner_user_id = NULL` on its rows; there is no
    // person to notify and that is not an error.
    const [orphan] = await db
      .insert(pets)
      .values({ publicToken: "DIM-CGDA-0009", name: "Sin Titular", species: "cat" })
      .returning({ id: pets.id });
    await expect(
      notifyTitularOfCaretakerDeath({
        petId: orphan.id,
        petName: "Sin Titular",
        petPublicToken: "DIM-CGDA-0009",
        caretakerUserId: CARETAKER_ID,
        eventId: "0cae7a13-5555-4000-8000-0000000000e9",
      }),
    ).resolves.toEqual({ notified: [] });
    await db.execute(sql`DELETE FROM pets WHERE public_token = 'DIM-CGDA-0009'`);
  });
});

// ---------------------------------------------------------------------------
// The GATE. It used to sit inline in createDeathRecordAction, where nothing
// could reach it — that file is a "use server" module behind a live Supabase
// session. Moving it next to the copy it guards made it testable, so it is
// tested. (Written after the move rather than before it; each control below was
// then PROVEN load-bearing by mutating the predicate and watching it go red.)
// ---------------------------------------------------------------------------
describe("announceCaretakerDeathRecord — the gate", () => {
  function access(holderRole: string | null) {
    return {
      pet: { id: petId, name: "Pampa", publicToken: PET_TOKEN },
      user: { id: CARETAKER_ID },
      holderRole,
    } as unknown as Parameters<typeof announceCaretakerDeathRecord>[0];
  }

  it("announces when a CARETAKER recorded the death", async () => {
    await announceCaretakerDeathRecord(access("caretaker"), EVENT_ID);
    expect(await notifiedUserIds()).toContain(TITULAR_ID);
  });

  it("says nothing when the TITULAR recorded it themselves", async () => {
    await announceCaretakerDeathRecord(access("owner"), EVENT_ID);
    expect(await notifiedUserIds()).toEqual([]);
  });

  it("says nothing on the ORG path, where holderRole is null by construction", async () => {
    await announceCaretakerDeathRecord(access(null), EVENT_ID);
    expect(await notifiedUserIds()).toEqual([]);
  });

  it("says nothing when the write was an idempotency noop", async () => {
    // No event id means no event was inserted — there is no second death to
    // announce, and announcing one would be inventing a fact.
    await announceCaretakerDeathRecord(access("caretaker"), null);
    expect(await notifiedUserIds()).toEqual([]);
  });

  it("swallows a failure — the record is already in the spine", async () => {
    // A pet id that cannot resolve: the notification path throws, the caller
    // must not. ARCH-P — a successful write may never be reported as failed
    // because a notice did not land.
    const broken = {
      pet: { id: "not-a-uuid", name: "Pampa", publicToken: PET_TOKEN },
      user: { id: CARETAKER_ID },
      holderRole: "caretaker",
    } as unknown as Parameters<typeof announceCaretakerDeathRecord>[0];
    await expect(announceCaretakerDeathRecord(broken, EVENT_ID)).resolves.toBeUndefined();
  });
});
