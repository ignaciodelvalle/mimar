// The draft store: what is keyed, what comes back, and what is refused.
//
// THREE OF THESE CASES ARE ABOUT REFUSING, and that is the right proportion.
// Storing text and getting it back is the easy half and it is also the half
// that fails loudly. The half that fails QUIETLY is the one where a draft comes
// back when it should not have: too old to still be about anything, written
// under a shape this build no longer understands, or holding a value that is
// not a string and turns a controlled input into an uncontrolled one halfway
// down a form somebody is typing into.
//
// AsyncStorage is the in-memory mock from `jest.setup.js` — REAL storage rather
// than a stub, because everything here is about what survives a write.

import { beforeEach, describe, expect, it } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  EVENT_DRAFT_MAX_AGE_MS,
  eventDraftKey,
  forgetAllEventDrafts,
  forgetEventDraft,
  pruneExpiredEventDrafts,
  readEventDraft,
  writeEventDraft,
} from "./event-draft-store";
import { type EventDraft, emptyDraft } from "./record-event-view-model";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "DIM-PAMP-0001";
const SOURCE = "33333333-3333-4333-8333-333333333333";

/** A fixed instant, so nothing here depends on when the suite runs. */
const NOW = Date.UTC(2026, 8, 17, 15, 30);
const DAY_MS = 24 * 60 * 60 * 1000;

const KEY = eventDraftKey({
  ownerId: OWNER,
  publicToken: TOKEN,
  kind: "note",
  sourceEventId: null,
});

/** A draft somebody typed into. */
function typed(overrides: Partial<EventDraft> = {}): EventDraft {
  return { ...emptyDraft(new Date(NOW)), text: "Comió poco hoy", ...overrides };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("eventDraftKey — what separates one form's scratch paper from another's", () => {
  it("separates two people on the same phone", () => {
    const mine = eventDraftKey({
      ownerId: OWNER,
      publicToken: TOKEN,
      kind: "note",
      sourceEventId: null,
    });
    const theirs = eventDraftKey({
      ownerId: OTHER_OWNER,
      publicToken: TOKEN,
      kind: "note",
      sourceEventId: null,
    });
    // THE SHARED-PHONE FENCE. Not a nicety: without the owner segment, the
    // second person to sign in on a family phone opens the nota form for the
    // household's dog and finds the first person's half-written sentence in it.
    expect(mine).not.toBe(theirs);
  });

  it("separates two pets and two kinds", () => {
    const base = { ownerId: OWNER, publicToken: TOKEN, kind: "note", sourceEventId: null } as const;
    expect(eventDraftKey(base)).not.toBe(eventDraftKey({ ...base, publicToken: "DIM-PAMP-0002" }));
    expect(eventDraftKey(base)).not.toBe(eventDraftKey({ ...base, kind: "weight" }));
  });

  it("separates two ends of two different treatments", () => {
    // `medication_end` IS THE ONE KIND WHOSE FORM IS ABOUT ANOTHER EVENT.
    // Sharing a key between them would restore the "Motivo" of treatment A into
    // the form that closes treatment B — a sentence about the wrong medication,
    // in a ledger that cannot be edited afterwards.
    const base = { ownerId: OWNER, publicToken: TOKEN, kind: "medication_end" } as const;
    expect(eventDraftKey({ ...base, sourceEventId: SOURCE })).not.toBe(
      eventDraftKey({ ...base, sourceEventId: "44444444-4444-4444-8444-444444444444" }),
    );
    expect(eventDraftKey({ ...base, sourceEventId: SOURCE })).not.toBe(
      eventDraftKey({ ...base, sourceEventId: null }),
    );
  });
});

describe("writeEventDraft / readEventDraft — the round trip", () => {
  it("gives back exactly what was typed, with when it was written", async () => {
    const draft = typed();
    await writeEventDraft(KEY, draft, NOW);

    const found = await readEventDraft(KEY, NOW + 60_000);
    expect(found?.values).toEqual(draft);
    expect(found?.savedAt).toBe(NOW);
  });

  it("answers null when nothing was ever stored", async () => {
    expect(await readEventDraft(KEY, NOW)).toBeNull();
  });

  it("keeps two pets' drafts apart in storage, not only in the key", async () => {
    const other = eventDraftKey({
      ownerId: OWNER,
      publicToken: "DIM-PAMP-0002",
      kind: "note",
      sourceEventId: null,
    });
    await writeEventDraft(KEY, typed({ text: "Pampa" }), NOW);
    await writeEventDraft(other, typed({ text: "Mate" }), NOW);

    expect((await readEventDraft(KEY, NOW))?.values.text).toBe("Pampa");
    expect((await readEventDraft(other, NOW))?.values.text).toBe("Mate");
  });
});

describe("readEventDraft — how old is too old", () => {
  it("still offers a draft one minute inside the window", async () => {
    await writeEventDraft(KEY, typed(), NOW);
    expect(await readEventDraft(KEY, NOW + EVENT_DRAFT_MAX_AGE_MS - 60_000)).not.toBeNull();
  });

  it("refuses a draft past the window", async () => {
    await writeEventDraft(KEY, typed(), NOW);
    // A THREE-WEEK-OLD DRAFT FOR A VACCINE THAT WAS RECORDED SOMEWHERE ELSE is
    // noise, and restoring it silently into a form that appends to a national
    // registry is worse than losing it.
    expect(await readEventDraft(KEY, NOW + 21 * DAY_MS)).toBeNull();
  });

  it("deletes the draft it refused, rather than leaving it to be refused forever", async () => {
    await writeEventDraft(KEY, typed(), NOW);
    await readEventDraft(KEY, NOW + 21 * DAY_MS);
    // Refusing protects the person; DELETING is what keeps somebody's free text
    // about a household from sitting on the phone after it stopped being
    // offerable.
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
  });

  it("refuses a draft that claims to come from the future", async () => {
    // A CLOCK THAT MOVED BACKWARD, which is the only way this happens: a phone
    // corrected after running fast, or a reset device before NTP lands. There
    // is no server timestamp to lean on — a draft was never anywhere but this
    // phone — so "written in the future" cannot be read as "brand new". It
    // means the age is unknowable, and an unknowable age is not offered.
    await writeEventDraft(KEY, typed(), NOW + 30 * DAY_MS);
    expect(await readEventDraft(KEY, NOW)).toBeNull();
  });
});

describe("readEventDraft — what it refuses to hand to a form", () => {
  it("refuses, and deletes, a value that is not readable JSON", async () => {
    await AsyncStorage.setItem(KEY, "{not json");
    expect(await readEventDraft(KEY, NOW)).toBeNull();
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
  });

  it("refuses an envelope with no timestamp", async () => {
    // Without `savedAt` there is no age, and with no age there is no expiry —
    // the one rule that bounds how long a stale sentence can wait.
    await AsyncStorage.setItem(KEY, JSON.stringify({ values: typed() }));
    expect(await readEventDraft(KEY, NOW)).toBeNull();
  });

  it("refuses an envelope whose draft is not an object", async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ savedAt: NOW, values: "Comió poco" }));
    expect(await readEventDraft(KEY, NOW)).toBeNull();
  });

  it("fills in a field the stored draft never had", async () => {
    // THE UPGRADE CASE. A draft written before a kind added a field comes back
    // missing it, and handing `undefined` to a `TextField` turns a controlled
    // input into an uncontrolled one: React Native stops re-rendering the box
    // and the person's typing stops appearing, three fields into a form.
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: NOW, values: { text: "Comió poco hoy" } }),
    );

    const found = await readEventDraft(KEY, NOW);
    expect(found?.values.text).toBe("Comió poco hoy");
    expect(found?.values.notes).toBe("");
    expect(found?.values.vaccineName).toBe("");
  });

  it("drops a key the draft no longer has", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: NOW, values: { ...typed(), retiredField: "algo" } }),
    );

    const found = await readEventDraft(KEY, NOW);
    expect(found?.values).not.toHaveProperty("retiredField");
  });

  it("drops a stored value that is not a string", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: NOW, values: { ...typed(), kg: 12.5, notes: { a: 1 } } }),
    );

    const found = await readEventDraft(KEY, NOW);
    expect(found?.values.kg).toBe("");
    expect(found?.values.notes).toBe("");
  });

  it("refuses a null where the form has no null to draw", async () => {
    // `dewormingType` IS A ONE-OF-N CHIP ROW WITH NO EMPTY STATE. A stored null
    // would draw a required chooser with nothing selected and no way for the
    // person to tell that something had been taken away from them; `severity`,
    // which really is optional, keeps its null.
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: NOW, values: { ...typed(), dewormingType: null, severity: null } }),
    );

    const found = await readEventDraft(KEY, NOW);
    expect(found?.values.dewormingType).toBe(emptyDraft().dewormingType);
    expect(found?.values.severity).toBeNull();
  });
});

describe("forgetting", () => {
  it("forgetEventDraft removes one and leaves the rest", async () => {
    const other = eventDraftKey({
      ownerId: OWNER,
      publicToken: TOKEN,
      kind: "weight",
      sourceEventId: null,
    });
    await writeEventDraft(KEY, typed(), NOW);
    await writeEventDraft(other, typed(), NOW);

    await forgetEventDraft(KEY);

    expect(await readEventDraft(KEY, NOW)).toBeNull();
    expect(await readEventDraft(other, NOW)).not.toBeNull();
  });

  it("forgetAllEventDrafts sweeps every owner and touches nothing else", async () => {
    await writeEventDraft(KEY, typed(), NOW);
    await writeEventDraft(
      eventDraftKey({
        ownerId: OTHER_OWNER,
        publicToken: TOKEN,
        kind: "note",
        sourceEventId: null,
      }),
      typed(),
      NOW,
    );
    await AsyncStorage.setItem("mimar.credential.v1.DIM-PAMP-0001", "{}");

    await forgetAllEventDrafts();

    expect(await AsyncStorage.getAllKeys()).toEqual(["mimar.credential.v1.DIM-PAMP-0001"]);
  });
});

describe("pruneExpiredEventDrafts — what is KEPT, not only what is offered", () => {
  it("removes the expired and keeps the fresh", async () => {
    const fresh = eventDraftKey({
      ownerId: OWNER,
      publicToken: TOKEN,
      kind: "weight",
      sourceEventId: null,
    });
    await writeEventDraft(KEY, typed(), NOW - 21 * DAY_MS);
    await writeEventDraft(fresh, typed(), NOW);

    await pruneExpiredEventDrafts(NOW);

    expect(await AsyncStorage.getItem(KEY)).toBeNull();
    expect(await AsyncStorage.getItem(fresh)).not.toBeNull();
  });

  it("removes what it cannot read, including a key from an older version", async () => {
    await AsyncStorage.setItem(KEY, "{not json");
    await AsyncStorage.setItem("mimar.eventDraft.v0.whatever", "{}");
    // Somebody else's key, to prove the sweep is bounded by the prefix.
    await AsyncStorage.setItem("mimar.credential.v1.DIM-PAMP-0001", "{}");

    await pruneExpiredEventDrafts(NOW);

    expect(await AsyncStorage.getAllKeys()).toEqual(["mimar.credential.v1.DIM-PAMP-0001"]);
  });
});

describe("the fence the narrowing rests on", () => {
  it("every field of an EventDraft is a string or null", () => {
    // `narrowStoredDraft` CASTS ONCE, in one place, on the strength of this.
    // The day a kind arrives whose draft field is a number, a boolean, or a
    // nested object, the cast becomes a lie — a stored value of that field
    // would be dropped in favour of a default that is not a string, and a form
    // would render it. Eighteen kinds and seventy-odd fields is too many to
    // re-check by reading, so this counts them instead.
    const offenders = Object.entries(emptyDraft()).filter(
      ([, value]) => value !== null && typeof value !== "string",
    );
    expect(offenders).toEqual([]);
  });
});
