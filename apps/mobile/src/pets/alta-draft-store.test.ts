// The alta wizard's draft store: what is keyed, what comes back, and what is
// refused. Mirrors `event-draft-store.test.ts` — same instrument (AsyncStorage,
// the real in-memory mock from `jest.setup.js`, not a stub), same shape of
// cases, because the two stores make the same promises for the same reasons.
// See `alta-draft-store.ts`'s header for what is different (one draft per
// owner, no pet/kind segment, a `stepIndex` alongside the fields).

import { beforeEach, describe, expect, it } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  ALTA_DRAFT_MAX_AGE_MS,
  altaDraftKey,
  forgetAllAltaDrafts,
  forgetAltaDraft,
  pruneExpiredAltaDrafts,
  readAltaDraft,
  writeAltaDraft,
} from "./alta-draft-store";
import { EMPTY_DRAFT, type PetDraft } from "./register-input";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";

/** A fixed instant, so nothing here depends on when the suite runs. */
const NOW = Date.UTC(2026, 8, 24, 15, 30);
const DAY_MS = 24 * 60 * 60 * 1000;

const KEY = altaDraftKey(OWNER);

/** A draft somebody typed into. */
function typed(overrides: Partial<PetDraft> = {}): PetDraft {
  return { ...EMPTY_DRAFT, name: "Pampa", species: "dog", ...overrides };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("altaDraftKey — one wizard, one owner", () => {
  it("separates two people on the same phone", () => {
    // THE SHARED-PHONE FENCE. Without the owner segment, the second person to
    // sign in on a family phone would open the wizard and find the first
    // person's half-registered animal in it.
    expect(altaDraftKey(OWNER)).not.toBe(altaDraftKey(OTHER_OWNER));
  });
});

describe("writeAltaDraft / readAltaDraft — the round trip", () => {
  it("gives back exactly what was typed, the step, and when it was written", async () => {
    const draft = typed();
    await writeAltaDraft(KEY, draft, 3, NOW);

    const found = await readAltaDraft(KEY, NOW + 60_000);
    expect(found?.draft).toEqual(draft);
    expect(found?.stepIndex).toBe(3);
    expect(found?.savedAt).toBe(NOW);
  });

  it("answers null when nothing was ever stored", async () => {
    expect(await readAltaDraft(KEY, NOW)).toBeNull();
  });

  it("keeps two owners' drafts apart in storage, not only in the key", async () => {
    const other = altaDraftKey(OTHER_OWNER);
    await writeAltaDraft(KEY, typed({ name: "Pampa" }), 0, NOW);
    await writeAltaDraft(other, typed({ name: "Michi" }), 0, NOW);

    expect((await readAltaDraft(KEY, NOW))?.draft.name).toBe("Pampa");
    expect((await readAltaDraft(other, NOW))?.draft.name).toBe("Michi");
  });
});

describe("readAltaDraft — how old is too old", () => {
  it("still offers a draft one minute inside the window", async () => {
    await writeAltaDraft(KEY, typed(), 0, NOW);
    expect(await readAltaDraft(KEY, NOW + ALTA_DRAFT_MAX_AGE_MS - 60_000)).not.toBeNull();
  });

  it("refuses a draft past the window", async () => {
    await writeAltaDraft(KEY, typed(), 0, NOW);
    // A THREE-WEEK-OLD HALF-REGISTERED PET is noise, and restoring it silently
    // is worse than losing it — the same argument `event-draft-store.ts` makes.
    expect(await readAltaDraft(KEY, NOW + 21 * DAY_MS)).toBeNull();
  });

  it("deletes the draft it refused, rather than leaving it to be refused forever", async () => {
    await writeAltaDraft(KEY, typed(), 0, NOW);
    await readAltaDraft(KEY, NOW + 21 * DAY_MS);
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
  });

  it("refuses a draft that claims to come from the future", async () => {
    // A clock that moved backward — the only way this happens, same reasoning
    // as the event drafts': "written in the future" cannot be read as "brand
    // new", so the age is unknowable and the draft is not offered.
    await writeAltaDraft(KEY, typed(), 0, NOW + 30 * DAY_MS);
    expect(await readAltaDraft(KEY, NOW)).toBeNull();
  });
});

describe("readAltaDraft — what it refuses to hand to the wizard", () => {
  it("refuses, and deletes, a value that is not readable JSON", async () => {
    await AsyncStorage.setItem(KEY, "{not json");
    expect(await readAltaDraft(KEY, NOW)).toBeNull();
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
  });

  it("refuses an envelope with no timestamp", async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ draft: typed(), stepIndex: 2 }));
    expect(await readAltaDraft(KEY, NOW)).toBeNull();
  });

  it("refuses an envelope whose draft is not an object", async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ savedAt: NOW, draft: "Pampa", stepIndex: 0 }));
    expect(await readAltaDraft(KEY, NOW)).toBeNull();
  });

  it("fills in a field the stored draft never had — the upgrade case", async () => {
    // A draft written before a field existed comes back missing it, and
    // handing `undefined` to a `TextField` turns a controlled input into an
    // uncontrolled one.
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: NOW, draft: { name: "Pampa" }, stepIndex: 0 }),
    );

    const found = await readAltaDraft(KEY, NOW);
    expect(found?.draft.name).toBe("Pampa");
    expect(found?.draft.color).toBe("");
    expect(found?.draft.provinceCode).toBe("");
  });

  it("drops a key the draft no longer has", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: NOW, draft: { ...typed(), retiredField: "algo" }, stepIndex: 0 }),
    );

    const found = await readAltaDraft(KEY, NOW);
    expect(found?.draft).not.toHaveProperty("retiredField");
  });

  it("drops a stored value that is not a string", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({
        savedAt: NOW,
        draft: { ...typed(), ageYears: 3, color: { a: 1 } },
        stepIndex: 0,
      }),
    );

    const found = await readAltaDraft(KEY, NOW);
    expect(found?.draft.ageYears).toBe("");
    expect(found?.draft.color).toBe("");
  });

  it("never restores duplicateOverride — it belongs to an attempt that has not happened yet", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({
        savedAt: NOW,
        draft: { ...typed(), duplicateOverride: true },
        stepIndex: 0,
      }),
    );

    const found = await readAltaDraft(KEY, NOW);
    expect(found?.draft.duplicateOverride).toBe(false);
  });

  it("collapses a negative or non-numeric step index to the first step", async () => {
    // `clampStepIndex` only rules out negative and non-integer values here —
    // it deliberately does not import `WIZARD_STEPS.length` (see the module
    // header). The upper bound against the CURRENT build's step count is the
    // call site's job (`AltaScreen.tsx`'s `onRestore`), covered in
    // `AltaScreen.test.tsx`.
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: NOW, draft: typed(), stepIndex: -3 }),
    );
    expect((await readAltaDraft(KEY, NOW))?.stepIndex).toBe(0);

    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ savedAt: NOW, draft: typed(), stepIndex: "confirmar" }),
    );
    expect((await readAltaDraft(KEY, NOW))?.stepIndex).toBe(0);
  });
});

describe("forgetting", () => {
  it("forgetAltaDraft removes one and leaves the rest", async () => {
    const other = altaDraftKey(OTHER_OWNER);
    await writeAltaDraft(KEY, typed(), 0, NOW);
    await writeAltaDraft(other, typed(), 0, NOW);

    await forgetAltaDraft(KEY);

    expect(await readAltaDraft(KEY, NOW)).toBeNull();
    expect(await readAltaDraft(other, NOW)).not.toBeNull();
  });

  it("forgetAllAltaDrafts sweeps every owner and touches nothing else", async () => {
    await writeAltaDraft(KEY, typed(), 0, NOW);
    await writeAltaDraft(altaDraftKey(OTHER_OWNER), typed(), 0, NOW);
    await AsyncStorage.setItem("mimar.credential.v1.DIM-PAMP-0001", "{}");

    await forgetAllAltaDrafts();

    expect(await AsyncStorage.getAllKeys()).toEqual(["mimar.credential.v1.DIM-PAMP-0001"]);
  });
});

describe("pruneExpiredAltaDrafts — what is KEPT, not only what is offered", () => {
  it("removes the expired and keeps the fresh", async () => {
    const fresh = altaDraftKey(OTHER_OWNER);
    await writeAltaDraft(KEY, typed(), 0, NOW - 21 * DAY_MS);
    await writeAltaDraft(fresh, typed(), 0, NOW);

    await pruneExpiredAltaDrafts(NOW);

    expect(await AsyncStorage.getItem(KEY)).toBeNull();
    expect(await AsyncStorage.getItem(fresh)).not.toBeNull();
  });

  it("removes what it cannot read, including a key from an older version", async () => {
    await AsyncStorage.setItem(KEY, "{not json");
    await AsyncStorage.setItem("mimar.altaDraft.v0.whatever", "{}");
    // Somebody else's key, to prove the sweep is bounded by the prefix.
    await AsyncStorage.setItem("mimar.credential.v1.DIM-PAMP-0001", "{}");

    await pruneExpiredAltaDrafts(NOW);

    expect(await AsyncStorage.getAllKeys()).toEqual(["mimar.credential.v1.DIM-PAMP-0001"]);
  });
});

describe("the fence the narrowing rests on", () => {
  it("every field of a PetDraft is a string or a boolean", () => {
    // `narrowStoredDraft` casts once, on the strength of this. A field of any
    // other shape would be dropped in favour of a default that is not a
    // string, and the wizard would render it.
    const offenders = Object.entries(EMPTY_DRAFT).filter(
      ([, value]) => typeof value !== "string" && typeof value !== "boolean",
    );
    expect(offenders).toEqual([]);
  });
});
