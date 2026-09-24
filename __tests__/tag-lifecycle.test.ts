// Integration tests for the physical-tag lifecycle writers + reads
// (activate-tag.ts / revoke-tag.ts / lib/infra/tag-lookup.ts).
//
// Fixture pattern: admin-SDK user creation, pets + ownerships + pet_tags
// inserted directly (mirrors microchip-replaced.test.ts).
//
// The load-bearing assertions:
//   - UNIFORM failure: wrong code, unknown serial and already-active all
//     return the exact same message, and no error string ever contains the
//     attempted code.
//   - Idempotency: a double-submit with the same clientIdempotencyKey returns
//     the ORIGINAL event and does not double-append.
//   - D4: revoke only from `active`; the revoked row KEEPS pet_id.
//   - lookupTagBySerial projection cannot leak the code hash (by shape).

import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Injection point for the error-hygiene suite at the bottom of this file: with
// `message` set, the payload validator both writers call inside their
// transaction throws an UNEXPECTED failure (not one of their own refusals).
// Null by default, so every other test in this file runs the real validator.
const { injectedPayloadFailure } = vi.hoisted(() => ({
  injectedPayloadFailure: { message: null as string | null },
}));

vi.mock("@/lib/events/event-schemas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/event-schemas")>();
  return {
    ...actual,
    validateEventPayload: (eventType: never, payload: unknown) => {
      if (injectedPayloadFailure.message) throw new Error(injectedPayloadFailure.message);
      return actual.validateEventPayload(eventType, payload);
    },
  };
});

import { auditLog, db, notifications, ownerships, petEvents, petTags, pets } from "@/db";
import { generateTagActivationCode, generateTagSerial } from "@/lib/infra/publicToken";
import { lookupTagBySerial, tagActivationCodeMatches } from "@/lib/infra/tag-lookup";
import { UNKNOWN_ERROR_FALLBACK } from "@/lib/ui/error-fallback";
import { hashTagActivationCode } from "@/lib/utils/tag-code-hash";
import { activateTagForUser } from "@/src/modules/pets/application/tags/activate-tag";
import { revokeTagForUser } from "@/src/modules/pets/application/tags/revoke-tag";
import { ACTIVATION_FAILED_MESSAGE } from "@/src/modules/pets/application/tags/types";
import { withMutationOverride } from "./_helpers/db-overrides";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const OWNER_EMAIL = "tag-owner@dim-test.local";
const STRANGER_EMAIL = "tag-stranger@dim-test.local";
const PASS = "TagLifecycleTest_2026!";
const TEST_LOTE = "TEST-LOTE-TAGLC";

let ownerUserId: string;
let strangerUserId: string;
let petId: string;

async function purgeUser(email: string) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === email);
  if (!found) return;
  const owned = await db
    .select({ petId: ownerships.petId })
    .from(ownerships)
    .where(eq(ownerships.ownerUserId, found.id));
  // pet_tags.pet_id has no ON DELETE action — clear tag rows before the pets.
  await db.delete(petTags).where(eq(petTags.loteId, TEST_LOTE));
  await withMutationOverride(async (tx) => {
    for (const { petId: id } of owned) await tx.delete(pets).where(eq(pets.id, id));
  });
  await admin.auth.admin.deleteUser(found.id);
}

/** Insert a blank (unactivated) tag and return {serial, code, id}. */
async function seedBlankTag() {
  const serial = generateTagSerial();
  const code = generateTagActivationCode();
  const [row] = await db
    .insert(petTags)
    .values({
      serial,
      activationCodeHash: hashTagActivationCode(code),
      loteId: TEST_LOTE,
    })
    .returning({ id: petTags.id });
  return { serial, code, id: row.id };
}

beforeAll(async () => {
  await purgeUser(OWNER_EMAIL);
  await purgeUser(STRANGER_EMAIL);

  const { data: ownerData, error: ownerErr } = await createFreshTestUser(admin, {
    email: OWNER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (ownerErr || !ownerData.user) throw new Error(`createUser owner: ${ownerErr?.message}`);
  ownerUserId = ownerData.user.id;

  const { data: strangerData, error: strangerErr } = await createFreshTestUser(admin, {
    email: STRANGER_EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (strangerErr || !strangerData.user)
    throw new Error(`createUser stranger: ${strangerErr?.message}`);
  strangerUserId = strangerData.user.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `DIM-TAGT-${Date.now().toString(36).toUpperCase().slice(-4)}`,
      name: "Tag Lifecycle Pet",
      species: "dog",
      sex: "male",
      status: "active",
    })
    .returning({ id: pets.id });
  petId = pet.id;

  await db.insert(ownerships).values({ petId, ownerUserId, role: "owner" });
}, 30_000);

afterAll(async () => {
  await purgeUser(OWNER_EMAIL);
  await purgeUser(STRANGER_EMAIL);
  await db.delete(petTags).where(eq(petTags.loteId, TEST_LOTE));
}, 30_000);

describe("activateTagForUser — happy path", () => {
  it("activates, appends tag_activated, audits, notifies, and flips the row", async () => {
    const { serial, code, id } = await seedBlankTag();

    const result = await activateTagForUser(ownerUserId, {
      serial,
      activationCode: code,
      petId,
    });
    expect(result).toMatchObject({ ok: true });
    if ("error" in result) throw new Error(result.error);

    // Row flipped with linkage.
    const [row] = await db.select().from(petTags).where(eq(petTags.id, id));
    expect(row.status).toBe("active");
    expect(row.petId).toBe(petId);
    expect(row.activatedByUserId).toBe(ownerUserId);
    expect(row.activatedAt).not.toBeNull();

    // Spine event, payload code-free.
    const [event] = await db.select().from(petEvents).where(eq(petEvents.id, result.eventId));
    expect(event.eventType).toBe("tag_activated");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.serial).toBe(serial);
    expect(payload.source).toBe("self");
    expect(JSON.stringify(payload)).not.toContain(code);

    // Audit row.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "tag.activate"));
    expect(
      audits.some((a) => (a.payload as { event_id?: string }).event_id === result.eventId),
    ).toBe(true);

    // Notification to the active owner, outside the tx.
    const notifs = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, ownerUserId),
          eq(notifications.notificationType, "tag_activated"),
        ),
      );
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs[0].ctaUrl).toBe("/cuenta/chapas");
  });

  it("case/whitespace-normalizes serial and code", async () => {
    const { serial, code } = await seedBlankTag();
    const result = await activateTagForUser(ownerUserId, {
      serial: `  ${serial.toLowerCase()} `,
      activationCode: ` ${code.toLowerCase()} `,
      petId,
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("is idempotent under the same clientIdempotencyKey (no second event)", async () => {
    const { serial, code } = await seedBlankTag();
    const idemKey = crypto.randomUUID();

    const first = await activateTagForUser(ownerUserId, {
      serial,
      activationCode: code,
      petId,
      clientIdempotencyKey: idemKey,
    });
    expect(first).toMatchObject({ ok: true });
    if ("error" in first) throw new Error(first.error);

    // The tag is now active, so the retry short-circuits on the idempotency
    // lookup BEFORE the state gate can produce the uniform failure.
    const second = await activateTagForUser(ownerUserId, {
      serial,
      activationCode: code,
      petId,
      clientIdempotencyKey: idemKey,
    });
    expect(second).toMatchObject({ ok: true, eventId: first.eventId });

    const events = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          eq(petEvents.eventType, "tag_activated"),
          eq(petEvents.clientIdempotencyKey, idemKey),
        ),
      );
    expect(events).toHaveLength(1);
  });
});

describe("activateTagForUser — uniform evidence gate", () => {
  it("wrong code, unknown serial and already-active all return the SAME message", async () => {
    const { serial, code } = await seedBlankTag();

    const wrongCode = await activateTagForUser(ownerUserId, {
      serial,
      activationCode: "AAAA-AAAA",
      petId,
    });
    const unknownSerial = await activateTagForUser(ownerUserId, {
      serial: "TAG-ZZZZ-ZZZZ",
      activationCode: code,
      petId,
    });

    // Activate for real, then attempt a second activation.
    const ok = await activateTagForUser(ownerUserId, { serial, activationCode: code, petId });
    expect(ok).toMatchObject({ ok: true });
    const alreadyActive = await activateTagForUser(ownerUserId, {
      serial,
      activationCode: code,
      petId,
    });

    for (const r of [wrongCode, unknownSerial, alreadyActive]) {
      expect(r).toEqual({ error: ACTIVATION_FAILED_MESSAGE });
      if ("error" in r) expect(r.error).not.toContain(code);
    }
  });

  it("keeps the tag unactivated after a wrong-code attempt", async () => {
    const { serial, id } = await seedBlankTag();
    await activateTagForUser(ownerUserId, { serial, activationCode: "BBBB-BBBB", petId });
    const [row] = await db.select().from(petTags).where(eq(petTags.id, id));
    expect(row.status).toBe("unactivated");
    expect(row.petId).toBeNull();
  });

  it("denies activation onto a pet the caller does not own", async () => {
    const { serial, code } = await seedBlankTag();
    const result = await activateTagForUser(strangerUserId, {
      serial,
      activationCode: code,
      petId,
    });
    expect("error" in result && result.error).toMatch(/ownership/i);
    if ("error" in result) expect(result.error).not.toContain(code);
  });
});

describe("revokeTagForUser", () => {
  async function seedActiveTag() {
    const tag = await seedBlankTag();
    const result = await activateTagForUser(ownerUserId, {
      serial: tag.serial,
      activationCode: tag.code,
      petId,
    });
    if ("error" in result) throw new Error(`fixture activation failed: ${result.error}`);
    return tag;
  }

  it("revokes an active tag, keeps pet_id, appends tag_revoked with revoke_reason", async () => {
    const { serial, id } = await seedActiveTag();

    const result = await revokeTagForUser(ownerUserId, {
      serial,
      revokeReason: "lost",
    });
    expect(result).toMatchObject({ ok: true });
    if ("error" in result) throw new Error(result.error);

    const [row] = await db.select().from(petTags).where(eq(petTags.id, id));
    expect(row.status).toBe("revoked");
    expect(row.petId).toBe(petId); // audit linkage preserved
    expect(row.revokedByUserId).toBe(ownerUserId);
    expect(row.revokedReason).toBe("lost");

    const [event] = await db.select().from(petEvents).where(eq(petEvents.id, result.eventId));
    expect(event.eventType).toBe("tag_revoked");
    const payload = event.payload as Record<string, unknown>;
    expect(payload.revoke_reason).toBe("lost");
    expect(payload).not.toHaveProperty("reason");
  });

  it("rejects revocation of a blank (unactivated) tag — D4", async () => {
    const { serial } = await seedBlankTag();
    const result = await revokeTagForUser(ownerUserId, { serial, revokeReason: "other" });
    expect("error" in result && result.error).toMatch(/active tag/i);
  });

  it("rejects revocation of an already-revoked tag (terminal state)", async () => {
    const { serial } = await seedActiveTag();
    const first = await revokeTagForUser(ownerUserId, { serial, revokeReason: "damaged" });
    expect(first).toMatchObject({ ok: true });
    const second = await revokeTagForUser(ownerUserId, { serial, revokeReason: "damaged" });
    expect("error" in second && second.error).toMatch(/active tag/i);
  });

  it("denies revocation by a non-owner of the linked pet", async () => {
    const { serial } = await seedActiveTag();
    const result = await revokeTagForUser(strangerUserId, { serial, revokeReason: "fraud" });
    expect("error" in result && result.error).toMatch(/ownership/i);
  });
});

describe("tag-lookup reads", () => {
  it("lookupTagBySerial: 4-state matrix and hash-free projection", async () => {
    // unknown
    expect(await lookupTagBySerial("TAG-YYYY-YYYY")).toBeNull();

    // unactivated → status only, no pet linkage
    const blank = await seedBlankTag();
    const blankLookup = await lookupTagBySerial(blank.serial);
    expect(blankLookup).toEqual({ status: "unactivated", publicToken: null });

    // active → publicToken present
    const active = await seedBlankTag();
    const activation = await activateTagForUser(ownerUserId, {
      serial: active.serial,
      activationCode: active.code,
      petId,
    });
    expect(activation).toMatchObject({ ok: true });
    const [petRow] = await db
      .select({ token: pets.publicToken })
      .from(pets)
      .where(eq(pets.id, petId));
    const activeLookup = await lookupTagBySerial(active.serial);
    expect(activeLookup).toEqual({ status: "active", publicToken: petRow.token });

    // revoked → status, and the projection STILL carries the token field but
    // the resolver never uses it for revoked (page contract, T5 tests).
    await revokeTagForUser(ownerUserId, { serial: active.serial, revokeReason: "lost" });
    const revokedLookup = await lookupTagBySerial(active.serial);
    expect(revokedLookup?.status).toBe("revoked");

    // Projection shape: exactly {status, publicToken} — the hash CANNOT leak.
    for (const lookup of [blankLookup, activeLookup, revokedLookup]) {
      expect(Object.keys(lookup as object).sort()).toEqual(["publicToken", "status"]);
    }
  });

  it("tagActivationCodeMatches: uniform false for empty attempt and unknown id", async () => {
    const { id, code } = await seedBlankTag();
    expect(await tagActivationCodeMatches(id, "")).toBe(false);
    expect(await tagActivationCodeMatches("00000000-0000-0000-0000-000000000000", code)).toBe(
      false,
    );
    expect(await tagActivationCodeMatches(id, code)).toBe(true);
    expect(await tagActivationCodeMatches(id, "CCCC-CCCC")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error hygiene (S1)
// ---------------------------------------------------------------------------
//
// Both writers used to end their transaction with
//   `${err instanceof Error ? err.message : String(err)}`
// which is returned to the client and rendered VERBATIM in the form's error
// banner (ActivateTagForm / RevokeTagDialog). That branch cannot distinguish a
// deliberate refusal from a Postgres error quoting the failing statement, so an
// internal fault was a disclosure. The fix marks the intended refusals
// (TagWriterRefusal) and replaces everything else with UNKNOWN_ERROR_FALLBACK,
// logging the real error server-side.
//
// The unexpected failure is injected through the payload validator both writers
// call INSIDE the transaction — a real code path, not a stubbed return.
describe("tag writers — error hygiene", () => {
  const INTERNAL_DETAIL =
    'insert into "pet_events" ("pet_id","payload") — column "payload" violates check constraint "pet_events_payload_shape"';

  afterEach(() => {
    injectedPayloadFailure.message = null;
    vi.restoreAllMocks();
  });

  async function seedActiveTagForHygiene() {
    const tag = await seedBlankTag();
    const result = await activateTagForUser(ownerUserId, {
      serial: tag.serial,
      activationCode: tag.code,
      petId,
    });
    if ("error" in result) throw new Error(`fixture activation failed: ${result.error}`);
    return tag;
  }

  it("activate: an unexpected internal failure is replaced, not forwarded", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { serial, code, id } = await seedBlankTag();
    injectedPayloadFailure.message = INTERNAL_DETAIL;

    const result = await activateTagForUser(ownerUserId, {
      serial,
      activationCode: code,
      petId,
    });

    expect(result).toEqual({ error: UNKNOWN_ERROR_FALLBACK });
    if ("error" in result) {
      expect(result.error).not.toContain("pet_events");
      expect(result.error).not.toContain("constraint");
      expect(result.error).not.toContain(code);
    }
    // The detail is not lost — it goes to the server log, where it belongs.
    // (Read off the Error itself: JSON.stringify(new Error(msg)) is "{}".)
    expect(logged).toHaveBeenCalled();
    const loggedError = logged.mock.calls[0]?.[1];
    expect(loggedError).toBeInstanceOf(Error);
    expect((loggedError as Error).message).toContain("pet_events");

    // And the transaction rolled back: the chapa is untouched.
    const [row] = await db.select().from(petTags).where(eq(petTags.id, id));
    expect(row.status).toBe("unactivated");
    expect(row.petId).toBeNull();
  });

  it("revoke: an unexpected internal failure is replaced, not forwarded", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { serial, id } = await seedActiveTagForHygiene();
    injectedPayloadFailure.message = INTERNAL_DETAIL;

    const result = await revokeTagForUser(ownerUserId, { serial, revokeReason: "damaged" });

    expect(result).toEqual({ error: UNKNOWN_ERROR_FALLBACK });
    if ("error" in result) {
      expect(result.error).not.toContain("pet_events");
      expect(result.error).not.toContain("constraint");
    }
    expect(logged).toHaveBeenCalled();

    const [row] = await db.select().from(petTags).where(eq(petTags.id, id));
    expect(row.status).toBe("active");
  });

  it("keeps the DELIBERATE refusals — hygiene must not flatten actionable messages", async () => {
    // Authorization and state refusals are written to be read by the caller;
    // replacing them with "Error desconocido" would be a regression in the
    // opposite direction.
    const blank = await seedBlankTag();
    const strangerActivation = await activateTagForUser(strangerUserId, {
      serial: blank.serial,
      activationCode: blank.code,
      petId,
    });
    expect("error" in strangerActivation && strangerActivation.error).toMatch(/ownership/i);

    const revokeBlank = await revokeTagForUser(ownerUserId, {
      serial: blank.serial,
      revokeReason: "other",
    });
    expect("error" in revokeBlank && revokeBlank.error).toMatch(/active tag/i);

    // …and the uniform evidence gate is untouched by all of this.
    const wrongCode = await activateTagForUser(ownerUserId, {
      serial: blank.serial,
      activationCode: "DDDD-DDDD",
      petId,
    });
    expect(wrongCode).toEqual({ error: ACTIVATION_FAILED_MESSAGE });
  });
});
