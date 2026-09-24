// Where an abandoned pet-registration wizard waits — the same mechanism
// `event-draft-store.ts` gives the bite/report forms (Re-2, decision 16A),
// sized for ONE draft instead of several: a person registers a pet once, so
// there is no "which pet, which kind" to key by, only "which person".
//
// EVERYTHING event-draft-store.ts's header argues holds here unchanged —
// AsyncStorage over SecureStore for the same three reasons (a draft grants
// nothing, chunking a wizard's fields through the Keystore's 2KB limit would
// buy nothing against an attacker already holding the unlocked phone, and the
// disclosure is bounded by the owner segment plus the same prune below), and a
// refused read is also a delete, for the same reason: a value this build
// cannot trust is a value it must not keep either.
//
// WHAT IS DIFFERENT
// ---------------------------------------------------------------------------
//   · THE KEY carries only the signed-in person's id. Two people can share a
//     phone, so that segment still fences one person's half-registered animal
//     from the other's — but there is no pet id to add, because the whole
//     point of this draft is that the pet does not exist on the server yet.
//   · THE STORED SHAPE carries the WIZARD STEP alongside the fields. A form
//     restored to "¿Cómo se llama?" after the person had already reached
//     "Confirmar" would ask five questions it already had answers to — the
//     scenario this whole feature exists to prevent, reintroduced by the fix.
//   · `duplicateOverride` NEVER SURVIVES. It is the answer to a 409 the server
//     gave THIS attempt, tied to the idempotency key `alta.tsx` creates fresh
//     per registration (`createAttemptSession`); a restored wizard starts a
//     new attempt, so an old "sí, registrala igual" would silently skip a
//     duplicate check for a submit the person has not yet made.

import AsyncStorage from "@react-native-async-storage/async-storage";

import { EMPTY_DRAFT, type PetDraft } from "./register-input";

/**
 * The key prefix, versioned — same shape as `event-draft-store.ts`'s
 * `KEY_PREFIX`, and for the same reason: the version rides in the key, so an
 * incompatible shape change strands old entries instead of making every read
 * parse-and-discard them, and the sweep below still finds them because it
 * matches the unversioned prefix.
 */
const KEY_PREFIX = "mimar.altaDraft.";
const KEY_VERSION = 1;
const KEY_VERSION_PREFIX = `${KEY_PREFIX}v${KEY_VERSION}.`;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * SEVEN DAYS, the same number and the same reasoning `event-draft-store.ts`
 * gives `EVENT_DRAFT_MAX_AGE_MS`: a draft is an interrupted act, not a filed
 * document, and the longest interruption that still describes the same act is
 * roughly a long weekend. A pet registered from a photo taken three weeks ago
 * is exactly the case `toRegisterPetInput` re-validates against the CURRENT
 * catalogs on submit regardless, so nothing here trusts a stale draft with
 * anything the server does not check again.
 */
export const ALTA_DRAFT_MAX_AGE_MS = 7 * DAY_MS;

/** What was found on disk, and when it was written. */
export type StoredAltaDraft = {
  draft: PetDraft;
  /** Which of `WIZARD_STEPS` the person was on. Clamped on read — see below. */
  stepIndex: number;
  savedAt: number;
};

/** The one place the key is spelled. Never build one by hand. */
export function altaDraftKey(ownerId: string): string {
  return `${KEY_VERSION_PREFIX}${ownerId}`;
}

/** Symmetric for the same reason `event-draft-store.ts`'s `isTooOld` is: a
 * device clock that moved backward makes "written in the future" as untrustworthy
 * as an age that is plainly too large. */
function isTooOld(savedAt: number, now: number): boolean {
  return Math.abs(now - savedAt) > ALTA_DRAFT_MAX_AGE_MS;
}

/**
 * A step index this build can act on — a non-negative integer, or `0`.
 *
 * NOT bounded against `WIZARD_STEPS.length` here: this module does not import
 * `register-input.ts`'s step list beyond `PetDraft`'s shape, and a stored
 * index one step past what THIS build ships (a step removed since) is exactly
 * as safe to clamp at the call site, which already owns `WIZARD_STEPS.length`.
 * Negative or non-numeric collapses to the first step, which is always safe to
 * show.
 */
function clampStepIndex(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * The stored object, narrowed back into a `PetDraft` — the same discipline
 * `event-draft-store.ts`'s `narrowStoredDraft` states, for the same two
 * reasons: a field ADDED to `PetDraft` since the draft was written is absent
 * from the stored object and must fall back to `EMPTY_DRAFT`'s default rather
 * than hand a `TextField` `undefined`; a field REMOVED since must not be
 * copied through.
 *
 * `duplicateOverride` — the one boolean in `PetDraft` — is never read back;
 * see the header for why that is a decision and not an oversight.
 */
function narrowStoredDraft(raw: unknown): PetDraft | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const stored = raw as Record<string, unknown>;
  const base = EMPTY_DRAFT as unknown as Record<string, string | boolean>;
  const narrowed: Record<string, string | boolean> = { ...base };
  for (const field of Object.keys(base)) {
    if (typeof base[field] === "boolean") continue; // duplicateOverride: never restored
    const value = stored[field];
    if (typeof value === "string") narrowed[field] = value;
  }
  return narrowed as unknown as PetDraft;
}

/**
 * Store the wizard's current fields and step.
 *
 * FAILURES ARE SWALLOWED, same contract as `writeEventDraft`: a storage write
 * that throws must never become a sentence on a form somebody is filling in.
 */
export async function writeAltaDraft(
  key: string,
  draft: PetDraft,
  stepIndex: number,
  now: number = Date.now(),
): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify({ savedAt: now, draft, stepIndex }));
  } catch {
    // See above.
  }
}

/**
 * The draft stored under `key`, or `null` — also the answer for one that is
 * too old, malformed, or written by a version this build does not understand.
 *
 * A DRAFT THAT IS REFUSED IS ALSO DELETED — the difference between an expiry
 * and a leak, same as `readEventDraft`.
 */
export async function readAltaDraft(
  key: string,
  now: number = Date.now(),
): Promise<StoredAltaDraft | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { savedAt?: unknown; draft?: unknown; stepIndex?: unknown };
    const savedAt = typeof parsed?.savedAt === "number" ? parsed.savedAt : null;
    const draft = savedAt === null ? null : narrowStoredDraft(parsed.draft);
    if (savedAt === null || draft === null || isTooOld(savedAt, now)) {
      await forgetAltaDraft(key);
      return null;
    }
    return { draft, stepIndex: clampStepIndex(parsed.stepIndex), savedAt };
  } catch {
    await forgetAltaDraft(key);
    return null;
  }
}

/**
 * Drop one draft. The only two legal callers are a submit the server accepted
 * and a person explicitly discarding the wizard — see `use-alta-draft.ts`.
 */
export async function forgetAltaDraft(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Best effort. Nothing useful can be said about scratch paper.
  }
}

/**
 * Remove every alta draft this app has ever written, regardless of owner or
 * age. Wired to the SAME deliberate exits `forgetAllEventDrafts` is (PO
 * decision 4A, via `session-store.ts`'s `sweepDraftsOnDeliberateExit`): a
 * half-registered pet's photo URI and locality are this person's own data, but
 * ordinary "Cerrar sesión" on this device, "Cerrar sesión en todos los
 * dispositivos", and "Eliminar mi cuenta" are all places where the person has
 * said, or the account has made final, that they are done — and a draft must
 * never survive into another account on the same phone.
 */
export async function forgetAllAltaDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((key) => key.startsWith(KEY_PREFIX));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch {
    // Best effort.
  }
}

/**
 * Delete every alta draft past `ALTA_DRAFT_MAX_AGE_MS`, plus anything under
 * our prefix this build cannot read — same reasoning and same shape as
 * `pruneExpiredEventDrafts`: a draft nobody ever reopens is never caught by
 * `readAltaDraft`'s own expiry check, because that only runs when somebody
 * opens the wizard again.
 */
export async function pruneExpiredAltaDrafts(now: number = Date.now()): Promise<void> {
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
    // Best effort, same as `pruneExpiredEventDrafts`: every read still refuses
    // an expired draft on its own.
  }
}
