// Where an unsent asiento waits while somebody is interrupted.
//
// WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT
// ---------------------------------------------------------------------------
// It is scratch paper on one phone. It is NOT a send queue, NOT a pending
// write, and NOT an event. Nothing in this file can create, imply or schedule a
// `pet_events` row: the only thing that ever writes an asiento is a person
// pressing the button on `RecordEventScreen`, with that form's own idempotency
// key, while they are looking at the form. Text that reached this module and
// never came back is text that was never sent, and the only one who can decide
// to send it is the person who typed it.
//
// THAT BOUNDARY IS THE POINT, and it is the PO's decision of 2026-09-16 taken
// in that order deliberately: persist the draft first, do NOT build the queue.
// A queue has to answer "what if the server refuses the retry?", and on an
// append-only spine a retry done wrong appends a SECOND asiento for one act.
// A draft cannot be retried because a draft was never a request.
//
// WHY AsyncStorage AND NOT SecureStore
// ---------------------------------------------------------------------------
// The same line `credential-cache.ts`, `qr-spotlight-preference.ts` and the
// launch-gate marker already draw, and it is worth restating because this one
// is the closest call of the four: a draft CAN hold third-party personal data.
// The mordedura form asks for the name, the phone and the approximate age of
// the person who was bitten, and the nota and síntoma forms are free text about
// a household.
//
// It is still AsyncStorage, for three reasons that hold together:
//
//   · The Keystore is for the things that grant access to OTHER data — the
//     refresh token and the access token (`auth/secure-store-auth-storage.ts`,
//     chunked through a 2048-byte-per-value API). A draft grants nothing. It is
//     a copy of what is already on the screen of an unlocked phone.
//   · An `EventDraft` is roughly seventy fields. Chunking it through that
//     2048-byte limit on every autosave, on the screen the product wants to be
//     FAST, would buy confidentiality against an attacker who already holds the
//     unlocked device — which is to say, none.
//   · The disclosure this actually creates is bounded and time-limited by the
//     two rules below: the key carries the id of the person who wrote it, so
//     nobody else's app session can read it back; and `pruneExpiredEventDrafts`
//     removes the bytes once the draft is too old to be offered.
//
// WHAT IS KEYED, AND WHY EACH SEGMENT IS THERE
// ---------------------------------------------------------------------------
// A draft belongs to a PERSON, a PET, a KIND, and — for the one kind that has
// one — a SOURCE ASIENTO.
//
//   · The person, because two people share a phone in this product's model.
//     `notifications/push-session-binding.ts` keys the push registration by
//     user id rather than by a boolean for exactly this reason, and the failure
//     it avoids is the same one: the second person must not inherit the first
//     person's state. Here the consequence would be worse than a misrouted
//     notification — it would be somebody finding a stranger's half-written
//     account of a dog bite in a form addressed to their own animal.
//   · The pet and the kind, because those are what the form IS.
//   · The source asiento, because `medication_end` is the one kind whose form
//     is about a specific other event. Without it, abandoning the end of
//     treatment A and later opening the end of treatment B would restore A's
//     "Motivo" under B's form: a sentence about the wrong medication, in a
//     ledger that cannot be edited afterwards.
//
// None of those segments can contain a `.`: a user id and a source id are
// UUIDs, a public token is `DIM-XXXX-XXXX`, and a kind is a snake_case literal
// from `WritableKind`. So `.` is an unambiguous separator here and the key
// cannot be made to collide by choosing a strange pet name.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { type EventDraft, type WritableKind, emptyDraft } from "./record-event-view-model";

/**
 * The key prefix, versioned — the same shape and the same reasoning as
 * `credential-cache.ts`. The version is in the KEY, so the day `EventDraft`
 * changes shape incompatibly a bump strands the old entries instead of making
 * every read parse-and-discard them, and the sweep below still finds them
 * because it matches the UNVERSIONED prefix.
 */
const KEY_PREFIX = "mimar.eventDraft.";
const KEY_VERSION = 1;
const KEY_VERSION_PREFIX = `${KEY_PREFIX}v${KEY_VERSION}.`;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How old a draft may be and still be offered back: SEVEN DAYS.
 *
 * THE NUMBER IS ABOUT WHAT A DRAFT MEANS, not about storage. A draft is an
 * INTERRUPTED ACT, not a document somebody filed. The longest interruption that
 * still describes the same act is roughly a long weekend: a vet visit somebody
 * meant to write down on Friday and comes back to on Monday is plainly the same
 * act, and restoring it helps. Three weeks later it is noise — by then the
 * vaccine was either recorded from the web, or written on paper, or forgotten
 * along with whatever the half-typed sentence was about. Restoring THAT
 * silently is worse than losing it, because these forms append to a national
 * registry and a stale sentence submitted by somebody who no longer remembers
 * writing it is a wrong fact nobody can delete afterwards.
 *
 * It also bounds the second thing: every form here pre-fills `occurredAt` with
 * TODAY, so a restored draft carries the day it was STARTED. Inside a week that
 * is almost always the right date and better than re-defaulting to today.
 * Beyond it, the date is as stale as the text.
 */
export const EVENT_DRAFT_MAX_AGE_MS = 7 * DAY_MS;

/** What was found on disk, and when it was written. */
export type StoredEventDraft = {
  values: EventDraft;
  /** Device clock at write time, ms since epoch. See `isTooOld`. */
  savedAt: number;
};

/** Everything that separates one form's scratch paper from another's. */
export type EventDraftIdentity = {
  /** The signed-in person's user id. See the header: this segment is the fence. */
  ownerId: string;
  publicToken: string;
  kind: WritableKind;
  /** Only `medication_end` has one. `null` for every other kind. */
  sourceEventId: string | null;
};

/** The one place the key is spelled. Never build one by hand. */
export function eventDraftKey(identity: EventDraftIdentity): string {
  const form =
    identity.sourceEventId === null ? identity.kind : `${identity.kind}~${identity.sourceEventId}`;
  return `${KEY_VERSION_PREFIX}${identity.ownerId}.${identity.publicToken}.${form}`;
}

/**
 * Whether a stored draft is too old to offer back.
 *
 * THE COMPARISON IS SYMMETRIC, and that is not tidiness. There is no server
 * timestamp to lean on the way `credential-cache.ts` leans on the credential's
 * own `issuedAt`: a draft was never anywhere but this phone, so the device
 * clock is the only clock there is. A clock that moved BACKWARD — a phone
 * corrected after running fast, a factory-reset device before NTP lands — makes
 * a draft look as if it were written in the future, and the honest reading of
 * "written in the future" is not "brand new", it is "I cannot tell how old this
 * is". So an age that cannot be read in either direction is treated the same
 * way as an age that is plainly too large: the draft is not offered.
 */
function isTooOld(savedAt: number, now: number): boolean {
  return Math.abs(now - savedAt) > EVENT_DRAFT_MAX_AGE_MS;
}

/**
 * The stored object, narrowed back into an `EventDraft`.
 *
 * IT MERGES OVER `emptyDraft()` RATHER THAN TRUSTING WHAT IT READ, and both
 * halves of that matter on a phone that updates itself:
 *
 *   · A field ADDED since the draft was written is absent from the stored
 *     object. Handing `undefined` to a `TextField` turns a controlled input
 *     into an uncontrolled one mid-form — React Native stops re-rendering the
 *     box and the person's typing stops appearing. The default from
 *     `emptyDraft()` is what keeps every field a string.
 *   · A field REMOVED since is still in the stored object, and copying it
 *     through would put a key on the draft that no longer exists in the type.
 *
 * TYPES ARE CHECKED, not assumed. Every field of `EventDraft` is a string or
 * `null` at runtime — the enums are string literal unions — and
 * `event-draft-store.test.ts` fences exactly that, so this narrowing stays
 * total as kinds are added. A stored value of any other shape is dropped in
 * favour of the default; `null` is only accepted where the default is `null`,
 * so a non-nullable chooser like `dewormingType` can never come back empty.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK is whether a string is a VALID member of
 * its enum. The value came from this app's own write on this same device, the
 * chip row simply draws nothing as selected if it is not one of the options,
 * and `validateDraft` plus the contract refuse it on submit. A second copy of
 * the catalogs here would be a second place for them to drift.
 */
function narrowStoredDraft(raw: unknown): EventDraft | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stored = raw as Record<string, unknown>;
  // SAFE BY THE FENCE NAMED ABOVE, and written as one cast in one place rather
  // than as seventy field reads.
  const base = emptyDraft() as unknown as Record<string, string | null>;
  const narrowed: Record<string, string | null> = { ...base };
  for (const field of Object.keys(base)) {
    const value = stored[field];
    if (typeof value === "string") {
      narrowed[field] = value;
      continue;
    }
    if (value === null && base[field] === null) narrowed[field] = null;
  }
  return narrowed as unknown as EventDraft;
}

/**
 * Store what somebody has typed so far.
 *
 * FAILURES ARE SWALLOWED, the same contract `writeCachedCredential` states: a
 * storage write that throws must never become a sentence on a form somebody is
 * in the middle of. They still have everything they typed on screen, and the
 * only thing lost is the copy that would have survived an interruption that has
 * not happened yet.
 */
export async function writeEventDraft(
  key: string,
  values: EventDraft,
  now: number = Date.now(),
): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify({ savedAt: now, values }));
  } catch {
    // See above.
  }
}

/**
 * The draft stored under a key, or `null` — and `null` is also the answer for
 * a draft that is too old, malformed, or written by a version this build does
 * not understand.
 *
 * A DRAFT THAT IS REFUSED IS ALSO DELETED, which is the difference between an
 * expiry and a leak. Refusing to restore it is what protects the person;
 * deleting it is what keeps a form they will never be shown from sitting on the
 * phone forever. See `pruneExpiredEventDrafts` for the drafts nobody opens
 * again.
 */
export async function readEventDraft(
  key: string,
  now: number = Date.now(),
): Promise<StoredEventDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; values?: unknown };
    const savedAt = typeof parsed?.savedAt === "number" ? parsed.savedAt : null;
    const values = savedAt === null ? null : narrowStoredDraft(parsed.values);
    if (savedAt === null || values === null || isTooOld(savedAt, now)) {
      await forgetEventDraft(key);
      return null;
    }
    return { values, savedAt };
  } catch {
    // A value this build cannot read is a value it must not keep either.
    await forgetEventDraft(key);
    return null;
  }
}

/**
 * Drop one draft.
 *
 * THE ONLY TWO CALLERS THAT MAY MEAN IT are a submit the server accepted and a
 * person pressing "Descartar". Everything else — leaving the screen, switching
 * kinds, backgrounding the app, a refused submit — must leave the draft where
 * it is. See `use-event-draft.ts`, which is where that rule is enforced.
 */
export async function forgetEventDraft(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Best effort. Nothing useful can be said to somebody about scratch paper.
  }
}

/**
 * Remove every draft this app has ever written, regardless of owner or age.
 *
 * WIRED TO THE DELIBERATE EXITS ONLY (PO decision 4A): "Cerrar sesión",
 * "Cerrar sesión en todos los dispositivos" and "Eliminar mi cuenta", through
 * `sweepDraftsOnDeliberateExit` in `auth/session-store.ts` — and to the two
 * terminal answers the server can give, `account_erased` and
 * `account_deactivated`. A draft of a bite holds a third party's name and
 * phone, and those exits are where the person has said, or the account has
 * made final, that they are done.
 *
 * NOT in `clearSession()`, although the obvious move is to put it next to
 * `forgetAllCachedCredentials()` there. `clearSession` is the funnel EVERY end
 * of a session passes through, including the one nobody chose: `accessToken()`'s
 * refused arm calls it when a refresh is rejected. Sweeping there would mean an
 * auth blip mid-form destroys the text somebody is writing — turning the exact
 * loss this whole module exists to prevent into a feature of the fix.
 * `session-store.test.ts` pins both halves.
 */
export async function forgetAllEventDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((key) => key.startsWith(KEY_PREFIX));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch {
    // Best effort.
  }
}

/**
 * Delete every draft that is past `EVENT_DRAFT_MAX_AGE_MS`, plus anything under
 * our prefix this build cannot read.
 *
 * WHY IT EXISTS AT ALL, given that `readEventDraft` already deletes what it
 * refuses: that deletion only happens when somebody OPENS that exact form
 * again, and the drafts most worth removing are precisely the ones nobody ever
 * goes back to. Without this, "seven days" would be a rule about what is
 * OFFERED and not a rule about what is KEPT, and a name and a phone number
 * belonging to somebody who was bitten would sit on the phone until the app was
 * uninstalled.
 *
 * CHEAP BY CONSTRUCTION AND OFF THE HOT PATH. It reads the key list once —
 * these are a handful of keys, one per form a person actually abandoned — and
 * it only reads the VALUES under our own prefix. `use-event-draft.ts` runs it
 * at most once per app process, after the screen has already restored and
 * rendered. No timer, no polling, nothing on a keystroke.
 *
 * OLD KEY VERSIONS GO TOO: it sweeps the unversioned prefix, and a key from a
 * `v0` this build cannot parse is exactly a draft that will never be offered.
 */
export async function pruneExpiredEventDrafts(now: number = Date.now()): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((key) => key.startsWith(KEY_PREFIX));
    const stale: string[] = [];
    for (const key of ours) {
      if (!key.startsWith(KEY_VERSION_PREFIX)) {
        stale.push(key);
        continue;
      }
      const raw = await AsyncStorage.getItem(key);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as { savedAt?: unknown };
        if (typeof parsed?.savedAt !== "number" || isTooOld(parsed.savedAt, now)) stale.push(key);
      } catch {
        stale.push(key);
      }
    }
    if (stale.length > 0) await AsyncStorage.multiRemove(stale);
  } catch {
    // Best effort, and a failure here costs nothing today: every read still
    // refuses an expired draft on its own.
  }
}

/** One draft found by `listEventDrafts`, identified by the pet it belongs to. */
export type FoundEventDraft = {
  publicToken: string;
  /** Device clock at write time, ms since epoch. Newest sorts first. */
  savedAt: number;
};

/**
 * Every non-expired draft this owner holds for one `kind`, newest first.
 *
 * BUILT FOR "MIS MASCOTAS" (M5 / Re-1, PO decision 3): the "Tenés una
 * mordedura sin enviar" banner has to find a bite draft WITHOUT already
 * knowing which pet it belongs to — every other reader in this file is
 * handed a full `EventDraftIdentity` by the form that is about to restore
 * one draft it already knows the key for. This one scans instead.
 *
 * SCOPED TO ONE OWNER AND ONE KIND BY CONSTRUCTION, not by filtering
 * afterward: the candidate keys are narrowed to `${prefix}${ownerId}.` before
 * anything is read, so this can never surface another signed-in account's
 * text — the same fence `eventDraftKey` draws. Only kinds whose
 * `sourceEventId` is always `null` are meaningful callers today (a bite
 * report never has one), so that segment is not exposed here; a kind that
 * DOES carry one, like `medication_end`, would need its key's `~source` tail
 * split out before this could tell two treatments apart.
 *
 * EVERY CANDIDATE GOES THROUGH `readEventDraft`, not a raw parse of what
 * `getAllKeys` returned: that is what makes "too old", "malformed" and "an
 * old key version" the same three refusals every other reader gets, rather
 * than a second copy of `isTooOld` and `narrowStoredDraft` that could drift
 * from the first. A draft `readEventDraft` refuses is deleted by it too, so
 * this sweep is also hygiene, same as `pruneExpiredEventDrafts` reasons for
 * itself above.
 */
export async function listEventDrafts({
  ownerId,
  kind,
  now = Date.now(),
}: {
  ownerId: string;
  kind: WritableKind;
  now?: number;
}): Promise<FoundEventDraft[]> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const prefix = `${KEY_VERSION_PREFIX}${ownerId}.`;
    const suffix = `.${kind}`;
    const candidates = keys.filter((key) => key.startsWith(prefix) && key.endsWith(suffix));
    const found: FoundEventDraft[] = [];
    for (const key of candidates) {
      const stored = await readEventDraft(key, now);
      if (stored === null) continue;
      found.push({
        publicToken: key.slice(prefix.length, key.length - suffix.length),
        savedAt: stored.savedAt,
      });
    }
    found.sort((a, b) => b.savedAt - a.savedAt);
    return found;
  } catch {
    // Best effort — see every other reader in this file. A scan that cannot
    // run is a banner that does not show, not a crash on "Mis mascotas".
    return [];
  }
}
