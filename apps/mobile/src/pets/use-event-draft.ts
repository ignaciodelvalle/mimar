// WHEN the draft is written, WHEN it is offered back, and — the sharp one —
// WHEN it is destroyed.
//
// The storage rules live in `event-draft-store.ts`. What lives here is timing,
// and timing is where every way of getting this wrong actually lands.
//
// WHEN IT SAVES
// ---------------------------------------------------------------------------
// Never on a keystroke, and never only on blur. Both of the obvious answers are
// wrong in a way this screen cannot afford:
//
//   · ON EVERY KEYSTROKE is a write per character, on the form the product
//     wants to be fast, on a cheap phone, in the middle of somebody describing
//     a bite. It is also a race against itself — seventy fields serialised
//     dozens of times a second, with no ordering guarantee between two
//     overlapping `setItem` calls for the same key.
//   · ONLY ON BLUR misses the case the feature is for. A person interrupted
//     mid-sentence never blurs anything: the call arrives, the app goes away,
//     and the OS reclaims it.
//
// So there are two triggers, and between them they cover every interruption
// named in the brief:
//
//   1. AN IDLE PAUSE. A single coalescing timer, armed only when the draft has
//      actually CHANGED since what is on disk, and re-armed by each keystroke
//      so a burst of typing costs exactly one write when the burst ends. There
//      is no timer at all while nobody is typing, and none once the draft
//      matches what was already stored. This is the trigger that survives the
//      one departure the app never hears about: the foreground process being
//      killed under memory pressure on a bad phone.
//   2. EVERY DEPARTURE. `AppState` leaving `active` — which is the phone
//      ringing, the app being backgrounded, and the last moment before the OS
//      reclaims a backgrounded process — and unmount, which is navigating away,
//      the back gesture, and "Elegir otro tipo". These write IMMEDIATELY and
//      cancel the pending idle write, because a departure is not a pause.
//
// WHY NOT FOCUS TOO. `useFocusEffect` would add a third trigger for navigating
// DEEPER without unmounting, and would cost this screen's tests a router mock
// they do not have. It buys nothing: a screen that is merely covered is not
// going anywhere, and the moment its process is at risk is the moment `AppState`
// already fires. A trigger that catches nothing new is a trigger to leave out.
//
// WHEN IT CLEARS — AND THIS IS THE ONE THAT CANNOT BE GOT WRONG
// ---------------------------------------------------------------------------
// A draft that outlives its own successful submit reappears on the next open
// and reads as "the app did not save my record" — which is the exact fear this
// feature exists to remove, delivered by the fix for it. So:
//
//   · It clears on SUCCESS, and on nothing else. `forgetOnSuccess` is named for
//     its only legal call site, so a future edit that reaches for it inside a
//     failure arm reads wrong on the line.
//   · A REFUSED submit keeps the draft, every kind of refusal: a validation
//     refusal that never left the device, an `api-error`, `unreachable`,
//     `malformed`, and the soft same-day gate — which is a QUESTION about a
//     write that did not happen, and whose whole point is that the same body
//     goes back on the same key.
//   · `wasDuplicate: true` IS A SUCCESS and clears. The server answering "this
//     idempotency key already appended" means the asiento is on the spine; the
//     scratch paper has no job left. Keeping it there would be the failure
//     above with an extra step.
//
// ONCE CLEARED, THE HOOK IS SEALED. `sealed` is checked by every writer,
// including the unmount write that fires a moment later when the screen
// navigates to the libreta. Without it, the success path would delete the draft
// and then immediately write it back — the bug in its purest form.
//
// WRITES ARE SERIALISED ON ONE PROMISE, so "delete after write" is ordered
// rather than hoped for. An idle write already in flight when somebody presses
// submit would otherwise be free to land AFTER the delete and resurrect a draft
// for an asiento that is already in the ledger.
//
// NOTHING HERE TOUCHES THE SPINE. This module reads and writes one AsyncStorage
// key. It has no idea what an event is, cannot send one, and cannot schedule
// one. See `event-draft-store.ts` for why that boundary is the PO's decision
// and not an implementation detail.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import { draftSweepEpoch, getSessionState } from "../auth/session-store";
import { sameDraft } from "../ui/use-draft-dirty";
import {
  type StoredEventDraft,
  eventDraftKey,
  forgetEventDraft,
  pruneExpiredEventDrafts,
  readEventDraft,
  writeEventDraft,
} from "./event-draft-store";
import type { EventDraft, WritableKind } from "./record-event-view-model";

/**
 * How long the form has to be quiet before the idle write fires.
 *
 * Long enough that typing a sentence is one write and not eight; short enough
 * that somebody who stops to think, and whose phone then dies, loses the last
 * breath of typing rather than the paragraph.
 */
const AUTOSAVE_IDLE_MS = 2_000;

/**
 * Whether the expired-draft sweep has already run in THIS app process.
 *
 * Module scope on purpose: it is a property of the process, not of a screen,
 * and every asentar form would otherwise repeat it. See
 * `pruneExpiredEventDrafts` for why once is enough and why it is cheap.
 */
let prunedThisProcess = false;

/**
 * The person signed in right now, or `null` when the session is in any other
 * phase. Only used to CAPTURE the owner — see `DraftOwner`.
 */
function currentOwnerId(): string | null {
  const state = getSessionState();
  return state.phase === "signed-in" ? state.user.id : null;
}

/**
 * Whose draft this is, and how many draft sweeps had run when the form found
 * out. Captured ONCE, on the first render in which somebody is signed in — the
 * route is behind `useGate`, so that is the first render — and never again.
 *
 * NEVER RE-CAPTURED, because a later capture would hand this form's text to
 * whoever is signed in by then: two people share a phone in this product's
 * model, and the owner id inside the key is what keeps them apart.
 */
type DraftOwner = { ownerId: string; sweepEpoch: number };

/**
 * May a write for `owner` still land? Asked AT WRITE TIME, twice — see
 * `persistNow` for why the key from the last render is not enough (A2b).
 *
 * REFUSED IN EXACTLY TWO CASES (A2c), and "nobody is signed in right now" is
 * NOT one of them:
 *
 *   · THE DRAFTS WERE SWEPT since the owner was captured. That is a person
 *     saying they are done ("Cerrar sesión", the erasure) or the server saying
 *     the account is (`account_erased`, `account_deactivated`), and the sweep
 *     took its list of keys once: a write landing behind it puts back the
 *     victim's name and phone the exit promised to remove. Refused even if the
 *     same person has signed back in since — the text was already thrown away
 *     on their word.
 *   · SOMEBODY ELSE IS SIGNED IN. Their session owns no draft of this one.
 *
 * A2b refused every phase other than `signed-in`, and that destroyed writing
 * on the path this feature exists for: weak signal, the refresh times out, the
 * phase becomes `session-unverified`, the gate swaps the form for the
 * "revisá tu conexión" screen, and the unmount write — the last edits — was
 * thrown away. `auth_expired` is the same story with a sign-in at the end of
 * it; neither sweeps, so neither may refuse.
 */
function mayStillWrite(owner: DraftOwner): boolean {
  if (draftSweepEpoch() !== owner.sweepEpoch) return false;
  const state = getSessionState();
  return state.phase !== "signed-in" || state.user.id === owner.ownerId;
}

export type UseEventDraft = {
  /**
   * The draft that was found and put on screen, or `null`. Drives the banner —
   * see `RecordEventScreen`, and see this module's note on why a restore is
   * announced rather than silent.
   */
  restored: StoredEventDraft | null;
  /** The person pressed "Descartar": wipe the stored copy and empty the form. */
  discardRestored: () => void;
  /** THE SERVER ACCEPTED THE ASIENTO. The only legal reason to delete a draft. */
  forgetOnSuccess: () => void;
};

export function useEventDraft({
  publicToken,
  kind,
  sourceEventId,
  draft,
  onRestore,
}: {
  publicToken: string;
  kind: WritableKind;
  sourceEventId: string | null;
  /** The form's live state. Compared by VALUE; a new object per render is fine. */
  draft: EventDraft;
  /** Put a recovered draft on screen. `setDraft` from the form. */
  onRestore: (values: EventDraft) => void;
}): UseEventDraft {
  const owner = useRef<DraftOwner | null>(null);
  if (owner.current === null) {
    const signedIn = currentOwnerId();
    if (signedIn !== null) owner.current = { ownerId: signedIn, sweepEpoch: draftSweepEpoch() };
  }
  const ownerId = owner.current?.ownerId ?? null;
  const key = useMemo(
    () => (ownerId === null ? null : eventDraftKey({ ownerId, publicToken, kind, sourceEventId })),
    [ownerId, publicToken, kind, sourceEventId],
  );

  const [restored, setRestored] = useState<StoredEventDraft | null>(null);

  // The draft as of THIS render, for the callbacks that fire outside one — the
  // AppState listener and the unmount cleanup. A closure over `draft` in an
  // effect with empty deps would write whatever the form held on mount, which
  // is precisely the empty draft nobody wants saved.
  const current = useRef(draft);
  current.current = draft;

  // What the form started with, captured once — the same trick and the same
  // reasoning as `useIsDirty`. It is what "nothing has been typed" means here,
  // and it cannot be `emptyDraft()` built on demand: that function reads the
  // clock, so a form open across midnight would compare unequal to itself.
  const pristine = useRef(draft);

  // What is on disk, as values. `null` means "nothing of ours is stored".
  const persisted = useRef<EventDraft | null>(null);

  // The asiento landed. Nothing may be written from here on. See the header.
  const sealed = useRef(false);

  // One chain, so a delete cannot overtake a write it was meant to follow.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  /** Write now, or decide there is nothing worth writing. */
  const persistNow = useCallback(() => {
    const writer = owner.current;
    if (key === null || writer === null || sealed.current) return;
    // ASKED AGAIN, AT WRITE TIME — `key` is not enough (A2b). A sign-out does
    // not have to produce another render: the form can unmount straight from
    // the render in which somebody was still signed in, and the idle timer
    // armed in that render fires two seconds later either way. Both of those
    // writes happen AFTER `forgetAllEventDrafts()` took its one snapshot of
    // the keys, so without this line a victim's name and phone typed just
    // before "Cerrar sesión" were written back behind the sweep and survived
    // it. What exactly is refused, and what is not, is `mayStillWrite`'s.
    if (!mayStillWrite(writer)) return;
    const values = current.current;
    // NEVER STORE AN UNTOUCHED FORM. Opening a form and leaving must not create
    // a draft: the next visit would then be greeted by a banner announcing the
    // recovery of nothing, which teaches people to ignore the banner before the
    // day it matters. Same argument `useIsDirty` makes for the discard guard.
    if (sameDraft(values, pristine.current)) return;
    if (persisted.current !== null && sameDraft(values, persisted.current)) return;
    // ASKED ONCE MORE WHEN THE QUEUE REACHES IT, because a write can wait
    // behind an earlier one for as long as that one takes, and the session can
    // end in between.
    //
    // `persisted` MOVES ONLY ONCE THE WRITE HAS PASSED AND LANDED. Marking the
    // values as saved before the queue asked would let a REFUSED write teach
    // this form that its text is on disk, and every later departure with the
    // same text would then skip the write it needed.
    queue.current = queue.current.then(async () => {
      if (!mayStillWrite(writer)) return;
      await writeEventDraft(key, values);
      persisted.current = values;
    });
  }, [key]);

  const forget = useCallback(() => {
    if (key === null) return;
    // Cleared IN the queue, for the same reason `persistNow` sets it there: a
    // write already queued ahead of this delete would otherwise land and put
    // its values back into `persisted` after the clear.
    queue.current = queue.current.then(() => {
      persisted.current = null;
      return forgetEventDraft(key);
    });
  }, [key]);

  const forgetOnSuccess = useCallback(() => {
    // SEALED FIRST AND SYNCHRONOUSLY. The unmount write fires a moment later,
    // when the screen replaces itself with the libreta.
    sealed.current = true;
    setRestored(null);
    forget();
  }, [forget]);

  const discardRestored = useCallback(() => {
    setRestored(null);
    forget();
    // Back to the form as it was BEFORE the restore, which is the form the
    // person would have got had there been no draft at all. Resetting to a
    // fresh `emptyDraft()` instead would be a second, different empty state —
    // and would leave the discard guard reading "dirty" over a blank form.
    onRestoreRef.current(pristine.current);
  }, [forget]);

  // RESTORE — once per key, on mount.
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void (async () => {
      const found = await readEventDraft(key);
      const offerable =
        alive &&
        found !== null &&
        !sealed.current &&
        // NEVER CLOBBER SOMEBODY WHO IS ALREADY TYPING. On a slow device the
        // read can land after the first keystroke, and overwriting what is on
        // screen with what was on disk would be this feature destroying writing
        // instead of saving it. A draft that arrives late is not offered.
        sameDraft(current.current, pristine.current);
      if (offerable && found !== null) {
        persisted.current = found.values;
        onRestoreRef.current(found.values);
        setRestored(found);
      }

      // THE SWEEP RUNS WHETHER OR NOT ANYTHING WAS FOUND, and that is the whole
      // point rather than a detail: the drafts most worth deleting are the ones
      // nobody ever goes back to, and hanging the sweep off a successful
      // restore would mean a phone holding ONLY expired drafts never sweeps
      // them — the exact case the expiry is supposed to bound.
      //
      // AFTER the read, never before it, because the person is waiting for
      // their text and this is hygiene. Once per process; see
      // `prunedThisProcess`.
      if (prunedThisProcess) return;
      prunedThisProcess = true;
      queue.current = queue.current.then(() => pruneExpiredEventDrafts());
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  // THE IDLE WRITE. Re-armed by each change, cleared by the next one, absent
  // entirely once the draft matches what is stored.
  useEffect(() => {
    if (key === null || sealed.current) return;
    if (sameDraft(draft, pristine.current)) return;
    if (persisted.current !== null && sameDraft(draft, persisted.current)) return;
    const timer = setTimeout(persistNow, AUTOSAVE_IDLE_MS);
    return () => clearTimeout(timer);
  }, [draft, key, persistNow]);

  // THE DEPARTURES. Both read `persistNow` through a ref so they can subscribe
  // once for the life of the form: a dependency on `persistNow` itself would
  // tear down and re-add the AppState listener whenever the key changed, and
  // would run the "unmount" cleanup on a form that is still on screen.
  const persistRef = useRef(persistNow);
  persistRef.current = persistNow;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      // ANYTHING THAT IS NOT `active`, and that includes iOS's `inactive`. The
      // brightness hook next door deliberately ignores `inactive` because
      // reacting to it would flicker the screen; here the cost of reacting is
      // one write that was going to happen anyway, and `inactive` is the FIRST
      // thing an incoming call raises. Missing it would mean betting the
      // person's typing on the `background` event that may or may not follow.
      if (next === "active") return;
      persistRef.current();
    });
    return () => subscription.remove();
  }, []);

  useEffect(
    () => () => {
      persistRef.current();
    },
    [],
  );

  return { restored, discardRestored, forgetOnSuccess };
}
