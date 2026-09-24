// Integration test for the pet_events append-only trigger.
// Runs against the local Postgres directly via Drizzle (bypassing RLS,
// which is exactly the surface the trigger has to close).

import { createClient } from "@supabase/supabase-js";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, db, ownerships, petEvents, pets } from "@/db";
import { withMutationOverride } from "./_helpers/db-overrides";
import { expectDbError } from "./_helpers/expect-db-error";
import { createFreshTestUser } from "./_helpers/fresh-test-user";

const SUPABASE_URL = "http://127.0.0.1:54321";
const SECRET = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
const admin = createClient(SUPABASE_URL, SECRET, {
  auth: { persistSession: false },
});

const EMAIL = "append-only-trigger-test@dim-test.local";
const PASS = "AppendOnlyTrigger_2026!";

let userId: string;
let petId: string;
let eventId: string;

beforeAll(async () => {
  const { data: list } = await admin.auth.admin.listUsers();
  const found = list?.users.find((u) => u.email === EMAIL);
  if (found) {
    const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, found.id));
    // Same reason as afterAll: pet cascade hits the append-only trigger.
    await withMutationOverride(async (tx) => {
      for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
    });
    await admin.auth.admin.deleteUser(found.id);
  }
  const { data, error } = await createFreshTestUser(admin, {
    email: EMAIL,
    password: PASS,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  userId = data.user.id;

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: `APPEND-ONLY-${userId.slice(0, 6).toUpperCase()}`,
      name: "Trigger",
      species: "dog",
      sex: "unknown",
      status: "active",
    })
    .returning();
  petId = pet.id;
  await db.insert(ownerships).values({ petId, ownerUserId: userId, role: "owner" });

  const now = new Date();
  const [event] = await db
    .insert(petEvents)
    .values({
      petId,
      eventType: "note_added",
      occurredAt: now,
      recordedAt: now,
      recordedByUserId: userId,
      authorRole: "owner",
      payload: { body: "smoke probe for the append-only trigger" },
    })
    .returning();
  eventId = event.id;
});

afterAll(async () => {
  // Pet cleanup cascades to pet_events; the append-only trigger blocks that
  // delete unless the escape hatch is set. Wrap in a tx with SET LOCAL so the
  // exception (the test fixture teardown) is explicitly opted in.
  const owned = await db.select().from(ownerships).where(eq(ownerships.ownerUserId, userId));
  await withMutationOverride(async (tx) => {
    for (const o of owned) await tx.delete(pets).where(eq(pets.id, o.petId));
  });
  await admin.auth.admin.deleteUser(userId);
});

describe("pet_events append-only trigger", () => {
  it("rejects db.update(petEvents) from a normal Drizzle path", async () => {
    // The trigger raises with errcode restrict_violation (23001) and a message
    // mentioning "append-only"; expectDbError matches it on the .cause chain.
    await expectDbError(
      db.update(petEvents).set({ notes: "should not stick" }).where(eq(petEvents.id, eventId)),
      { constraint: /append-only/i },
    );
  });

  it("rejects db.delete(petEvents) from a normal Drizzle path", async () => {
    await expectDbError(db.delete(petEvents).where(eq(petEvents.id, eventId)), {
      constraint: /append-only/i,
    });
  });

  it("event row is unchanged after the rejected mutations", async () => {
    const [row] = await db.select().from(petEvents).where(eq(petEvents.id, eventId));
    expect(row).toBeDefined();
    expect(row.notes).toBe(null);
  });

  it("allows mutation when the session-local escape hatch is set", async () => {
    // withMutationOverride wraps the update in a tx with both required GUCs.
    // Escape hatch is scoped to this tx only and reverts on commit.
    await withMutationOverride(async (tx) => {
      await tx
        .update(petEvents)
        .set({ notes: "audited correction via escape hatch" })
        .where(eq(petEvents.id, eventId));
    });
    const [row] = await db.select().from(petEvents).where(eq(petEvents.id, eventId));
    expect(row.notes).toBe("audited correction via escape hatch");
  });

  it("blocks future mutations again once the tx with the escape hatch ends", async () => {
    await expectDbError(
      db
        .update(petEvents)
        .set({ notes: "should not stick either" })
        .where(eq(petEvents.id, eventId)),
      { constraint: /append-only/i },
    );
  });
});

// ---------------------------------------------------------------------------
// The override's accountability clause (finding A08-1) and its pre-image
// (finding A08-2, migration 0235). case-events-append-only.test.ts has tested
// the missing-actor refusal and the audit row for months; the more important
// table had neither, so deleting the refusal from the trigger kept every test
// green.
//
// The images are an ALLOWLIST (see the 0235 header): only values that cannot
// carry a name, a contact or prose are copied; every other key is named in
// `redacted_keys` without its value. audit_log is never erased, so anything
// copied into it outlives erase_subject_data.
// ---------------------------------------------------------------------------

type AuditImage = {
  event_type: string;
  notes_present: boolean;
  payload: Record<string, unknown> | null;
  redacted_keys: string[] | null;
};

type OverrideAudit = {
  operation: string;
  old: AuditImage | null;
  new: AuditImage | null;
  changed_keys: string[] | null;
  notes_changed: boolean;
};

async function overrideRows(targetEventId: string) {
  return db
    .select({ actorUserId: auditLog.actorUserId, payload: auditLog.payload })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "pet_events_mutation_override"),
        sql`${auditLog.payload}->>'pet_event_id' = ${targetEventId}`,
      ),
    )
    .orderBy(auditLog.performedAt);
}

async function adminActorId(): Promise<string> {
  const rows = (await db.execute(sql`
    select p.id::text as id from public.profiles p
    join auth.users u on u.id = p.id where u.email = 'admin@dim.test' limit 1
  `)) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("admin@dim.test missing — run pnpm db:bootstrap");
  return rows[0].id;
}

/** Inserts a raw event (no payload validation — the trigger must cope with anything). */
async function insertRawEvent(eventType: string, payload: unknown, notes: string | null = null) {
  const [row] = (await db.execute(sql`
    insert into public.pet_events (pet_id, event_type, occurred_at, recorded_at, recorded_by_user_id, author_role, payload, notes)
    values (${petId}::uuid, ${eventType}, now(), now(), ${userId}::uuid, 'owner', ${JSON.stringify(payload)}::jsonb, ${notes})
    returning id::text as id
  `)) as unknown as Array<{ id: string }>;
  return row.id;
}

// One secret per key the 2026-09 security review found leaking through the
// first (denylist) draft, plus the erase RPC's own keys, plus shapes an
// allowlist has to refuse even under an allowlisted key NAME.
const TEXT_UUID = "0cae7a15-7777-4000-8000-000000000001";
const PII_PAYLOAD: Record<string, unknown> = {
  // note_added
  text: "SECRET-text Av. Siempreviva 742",
  finderName: "SECRET-finderName Ana",
  finderContact: "SECRET-finderContact +5491100000001",
  message: "SECRET-message llamame",
  // incident_reported
  injuries_summary: "SECRET-injuries mordida en la mano de Ana",
  victim_age_estimate: "SECRET-victim_age 7",
  victim_contact_name: "SECRET-victim_contact_name",
  victim_contact_phone: "SECRET-victim_contact_phone",
  context: "SECRET-context frente a la casa",
  // symptom_observed
  free_text: "SECRET-free_text",
  // adoption_application_submitted
  motivation: "SECRET-motivation",
  daily_routine: "SECRET-daily_routine",
  other_pets: "SECRET-other_pets",
  // shelter_intake_recorded
  seizure_motive_other_detail: "SECRET-seizure_detail",
  judicial_proceeding_reference: "SECRET-judicial_ref",
  // death_recorded / clinical_info_logged / vet_visit_logged
  cause_detail: "SECRET-cause_detail",
  details: "SECRET-details",
  diagnosis: "SECRET-diagnosis",
  // nested and location
  lost_description: { behavior_notes: "SECRET-behavior", color_notes: "SECRET-color" },
  scan_coords: { lat: -34.61234, lng: -58.41234 },
  // allowlisted NAMES carrying the wrong SHAPE
  to_user_id: "SECRET-display-name-under-an-id-key",
  severity: "SECRET grave porque",
  occurred_on: "SECRET-not-a-date",
  dni: 30123456,
  // Migration 0238, fresh-context review pre-push (item 8): the old enum-value
  // regex `^[a-z0-9_]{1,64}$` treats ANY string of lowercase letters, digits
  // and underscores as a safe token — including one that is ENTIRELY DIGITS,
  // which no real enum value in this codebase ever is. A phone number
  // accidentally written under an enum-shaped key (`source`) used to be
  // copied into the audit pre-image as if it were 'scanner' or 'open'. No
  // "SECRET-" prefix on purpose: a digits-only value is exactly the shape the
  // OLD regex accepted, so this key must earn its own not-contains assertion
  // below rather than ride the generic SECRET-prefix check.
  source: "01144556677",
};
const STRUCTURAL_PAYLOAD: Record<string, unknown> = {
  payload_version: 1,
  incident_type: "bite_inflicted",
  severity: "minor",
  vet_involved: true,
  victim_pet_id: TEXT_UUID,
  next_due_at: "2026-10-01",
  tipo_evento_code: 12,
  rabies_vaccine_valid_at_incident: null,
};

describe("pet_events override — accountability and pre-image", () => {
  it("refuses the override when the bypass flag has NO accountable actor", async () => {
    await expectDbError(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local app.allow_event_mutation = 'true'`);
        await tx.update(petEvents).set({ notes: "unaccountable" }).where(eq(petEvents.id, eventId));
      }),
      { code: "23001", constraint: /allow_event_mutation_actor/ },
    );
    const [row] = await db.select().from(petEvents).where(eq(petEvents.id, eventId));
    expect(row.notes).not.toBe("unaccountable");
  });

  it("writes an audit row naming the GUC actor, with old and new structural images", async () => {
    const id = await insertRawEvent("note_added", {
      payload_version: 1,
      category: "system",
      text: "SECRET-before",
    });
    await withMutationOverride(async (tx) => {
      await tx
        .update(petEvents)
        .set({
          payload: { payload_version: 1, category: "medical", text: "SECRET-after" },
          notes: "SECRET-notes",
        })
        .where(eq(petEvents.id, id));
    });

    const rows = await overrideRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(await adminActorId());

    const p = rows[0].payload as OverrideAudit;
    expect(p.operation).toBe("UPDATE");
    // The pre-image is the point: the structural value before the rewrite survives.
    expect(p.old?.payload).toEqual({ payload_version: 1, category: "system" });
    expect(p.new?.payload).toEqual({ payload_version: 1, category: "medical" });
    // …and the prose is visible only as the NAME of a key that changed.
    expect(p.old?.redacted_keys).toEqual(["text"]);
    expect(p.changed_keys).toEqual(["category", "text"]);
    expect(p.old?.event_type).toBe("note_added");
    expect(p.old?.notes_present).toBe(false);
    expect(p.new?.notes_present).toBe(true);
    expect(p.notes_changed).toBe(true);
    expect(JSON.stringify(p)).not.toContain("SECRET");
  });

  it("copies only allowlisted shapes: every PII key is named, never valued", async () => {
    const id = await insertRawEvent(
      "incident_reported",
      { ...PII_PAYLOAD, ...STRUCTURAL_PAYLOAD, severity: PII_PAYLOAD.severity },
      "SECRET-notes-column",
    );
    await withMutationOverride(async (tx) => {
      await tx
        .update(petEvents)
        .set({
          payload: sql`${petEvents.payload} - 'victim_contact_name' - 'victim_contact_phone'`,
        })
        .where(eq(petEvents.id, id));
      await tx.delete(petEvents).where(eq(petEvents.id, id));
    });

    const rows = (await overrideRows(id)).map((r) => r.payload as OverrideAudit);
    expect(rows.map((r) => r.operation).sort()).toEqual(["DELETE", "UPDATE"]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("30123456");
    expect(serialized).not.toContain("-34.61234");
    // Migration 0238 (item 8): a digits-only value under the enum-shaped
    // `source` key must be redacted, not copied as a "safe" enum token.
    expect(serialized).not.toContain("01144556677");

    const update = rows.find((r) => r.operation === "UPDATE");
    const piiKeys = Object.keys(PII_PAYLOAD).sort();
    expect(update?.old?.redacted_keys).toEqual(piiKeys);
    // The structural keys survive, value and all.
    const { severity: _s, ...structuralKept } = STRUCTURAL_PAYLOAD;
    expect(update?.old?.payload).toEqual(structuralKept);
    expect(update?.changed_keys).toEqual(["victim_contact_name", "victim_contact_phone"]);
    expect(update?.notes_changed).toBe(false);

    const del = rows.find((r) => r.operation === "DELETE");
    expect(del?.new).toBeNull();
    expect(del?.changed_keys).toBeNull();
    expect(del?.old?.payload).toEqual(structuralKept);
  });

  it("records a null image instead of raising when the payload is not a JSON object", async () => {
    const id = await insertRawEvent("note_added", "SECRET-a-bare-string");
    await withMutationOverride(async (tx) => {
      await tx
        .update(petEvents)
        .set({ payload: sql`'["SECRET-an-array"]'::jsonb` })
        .where(eq(petEvents.id, id));
    });

    const [row] = await overrideRows(id);
    const p = row.payload as OverrideAudit;
    expect(p.old?.payload).toBeNull();
    expect(p.old?.redacted_keys).toBeNull();
    expect(p.new?.payload).toBeNull();
    expect(p.changed_keys).toBeNull();
    expect(JSON.stringify(p)).not.toContain("SECRET");
  });
});
