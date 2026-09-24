// WHEN the alta wizard's draft is written, restored, and destroyed — the same
// three questions `use-event-draft.ts` answers for the bite/report forms
// (Re-2, decision 16A), answered here for the one wizard that has no pet yet.
// See that module's header for the full reasoning on the two save triggers (an
// idle pause, and every departure) and on why a successful submit is the only
// ordinary reason to delete; both hold here unchanged. What is different is
// the SHAPE of what is restored: a step index rides alongside the fields,
// because a wizard that forgot which of six screens it was on would greet a
// process death with the first question again.
//
// THE SCENARIO THIS EXISTS FOR is a 2016 Android reclaiming the app's process
// while the person is in the camera or the gallery, mid-alta — not a network
// retry. A discarded draft was never a request, exactly as
// `event-draft-store.ts` states for its own forms: the only thing that can
// ever create the pet is `POST /pets`, fired by a person pressing "Registrar
// mascota" while looking at the confirm step.
//
// EXPLICIT DISCARD, HERE, IS CONFIRMING "Salir del alta". Unlike the asiento
// forms — which offer a dedicated "Descartar el borrador" because leaving them
// ordinarily KEEPS the draft — this wizard's own back-guard already tells the
// person "Lo que cargaste hasta acá se pierde" before they leave
// (`DISCARD_COPY.alta`, `use-discard-guard.ts`). Persisting past that
// confirmation would make the sentence they just agreed to false. So the
// wizard's own "Salir" answers both questions at once: it navigates away AND
// it is the discard. A process death, an incoming call, or the app simply
// leaving the foreground mid-wizard — none of which route through that
// dialog — are exactly what stays recoverable.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";

import { draftSweepEpoch, getSessionState } from "../auth/session-store";
import { sameDraft } from "../ui/use-draft-dirty";
import {
  altaDraftKey,
  forgetAltaDraft,
  pruneExpiredAltaDrafts,
  readAltaDraft,
  writeAltaDraft,
} from "./alta-draft-store";
import { EMPTY_DRAFT, type PetDraft } from "./register-input";

/** Same coalescing window `use-event-draft.ts` uses, for the same reason: long
 * enough that a burst of typing is one write, short enough that a phone that
 * dies mid-pause loses only the last breath of it. */
const AUTOSAVE_IDLE_MS = 2_000;

/** Once per app process — see `pruneExpiredEventDrafts` for why once is
 * enough and why it is cheap. Module scope: a property of the process. */
let prunedThisProcess = false;

function currentOwnerId(): string | null {
  const state = getSessionState();
  return state.phase === "signed-in" ? state.user.id : null;
}

type DraftOwner = { ownerId: string; sweepEpoch: number };

/**
 * May a write for `owner` still land? Same two refusals as
 * `use-event-draft.ts`'s `mayStillWrite`, asked at write time for the same
 * reason (A2b/A2c): the drafts were swept since the owner was captured, or
 * somebody else is signed in now. Neither is "nobody is signed in right now"
 * — a refresh that only timed out must not cost a half-typed wizard.
 */
function mayStillWrite(owner: DraftOwner): boolean {
  if (draftSweepEpoch() !== owner.sweepEpoch) return false;
  const state = getSessionState();
  return state.phase !== "signed-in" || state.user.id === owner.ownerId;
}

/**
 * Whether `values`/`step` are still the wizard's untouched starting point —
 * `EMPTY_DRAFT` at step 0, which is the only value this wizard is ever seeded
 * with. A MODULE-LEVEL function and not a `useCallback`: it closes over
 * nothing render-specific, so it needs no place in an effect's dependency
 * list, the same way `sameDraft` and `mayStillWrite` do not.
 */
function isUntouched(values: PetDraft, step: number): boolean {
  return sameDraft(values, EMPTY_DRAFT) && step === 0;
}

export type UseAltaDraft = {
  /** THE SERVER ACCEPTED THE REGISTRATION. The ordinary reason to delete. */
  forgetOnSuccess: () => void;
  /** The person confirmed "Salir del alta" — wipe the stored copy. */
  discardOnExit: () => void;
};

export function useAltaDraft({
  draft,
  stepIndex,
  onRestore,
}: {
  /** The wizard's live state. Compared by value; a new object per render is fine. */
  draft: PetDraft;
  stepIndex: number;
  /** Put a recovered draft and step back on screen. */
  onRestore: (values: PetDraft, stepIndex: number) => void;
}): UseAltaDraft {
  const owner = useRef<DraftOwner | null>(null);
  if (owner.current === null) {
    const signedIn = currentOwnerId();
    if (signedIn !== null) owner.current = { ownerId: signedIn, sweepEpoch: draftSweepEpoch() };
  }
  const ownerId = owner.current?.ownerId ?? null;
  const key = useMemo(() => (ownerId === null ? null : altaDraftKey(ownerId)), [ownerId]);

  // The draft/step as of THIS render, for the callbacks that fire outside one
  // — the AppState listener and the unmount cleanup. A closure with empty deps
  // would write whatever the form held on mount, which is the empty draft
  // nobody wants saved.
  const current = useRef(draft);
  current.current = draft;
  const currentStep = useRef(stepIndex);
  currentStep.current = stepIndex;

  // What is on disk, as values. `null` means "nothing of ours is stored".
  const persisted = useRef<{ draft: PetDraft; stepIndex: number } | null>(null);

  // The pet was registered. Nothing may be written from here on.
  const sealed = useRef(false);

  // One chain, so a delete cannot overtake a write it was meant to follow.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  /** Write now, or decide there is nothing worth writing. */
  const persistNow = useCallback(() => {
    const writer = owner.current;
    if (key === null || writer === null || sealed.current) return;
    if (!mayStillWrite(writer)) return;
    const values = current.current;
    const step = currentStep.current;
    // NEVER STORE AN UNTOUCHED WIZARD — opening it and leaving must not create
    // a draft to restore later.
    if (isUntouched(values, step)) return;
    if (
      persisted.current !== null &&
      sameDraft(values, persisted.current.draft) &&
      step === persisted.current.stepIndex
    ) {
      return;
    }
    queue.current = queue.current.then(async () => {
      if (!mayStillWrite(writer)) return;
      await writeAltaDraft(key, values, step);
      persisted.current = { draft: values, stepIndex: step };
    });
  }, [key]);

  const forget = useCallback(() => {
    if (key === null) return;
    queue.current = queue.current.then(() => {
      persisted.current = null;
      return forgetAltaDraft(key);
    });
  }, [key]);

  const forgetOnSuccess = useCallback(() => {
    sealed.current = true;
    forget();
  }, [forget]);

  const discardOnExit = useCallback(() => {
    sealed.current = true;
    forget();
  }, [forget]);

  // RESTORE — once, on mount.
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void (async () => {
      const found = await readAltaDraft(key);
      const offerable =
        alive &&
        found !== null &&
        !sealed.current &&
        // NEVER CLOBBER SOMEBODY ALREADY TYPING — same race
        // `use-event-draft.ts` guards: a read that lands after the first
        // keystroke must not overwrite what is on screen.
        isUntouched(current.current, currentStep.current);
      if (offerable && found !== null) {
        persisted.current = { draft: found.draft, stepIndex: found.stepIndex };
        onRestoreRef.current(found.draft, found.stepIndex);
      }

      // THE SWEEP RUNS WHETHER OR NOT ANYTHING WAS FOUND — same reasoning as
      // `pruneExpiredEventDrafts`'s call site: the drafts most worth deleting
      // are the ones nobody ever goes back to.
      if (prunedThisProcess) return;
      prunedThisProcess = true;
      queue.current = queue.current.then(() => pruneExpiredAltaDrafts());
    })();
    return () => {
      alive = false;
    };
  }, [key]);

  // THE IDLE WRITE. Re-armed by each change, absent once the draft matches
  // what is stored.
  useEffect(() => {
    if (key === null || sealed.current) return;
    if (isUntouched(draft, stepIndex)) return;
    if (
      persisted.current !== null &&
      sameDraft(draft, persisted.current.draft) &&
      stepIndex === persisted.current.stepIndex
    ) {
      return;
    }
    const timer = setTimeout(persistNow, AUTOSAVE_IDLE_MS);
    return () => clearTimeout(timer);
  }, [draft, stepIndex, key, persistNow]);

  // THE DEPARTURES. Read through a ref so both subscribe once for the life of
  // the form — a dependency on `persistNow` itself would tear down and re-add
  // the AppState listener on every keystroke.
  const persistRef = useRef(persistNow);
  persistRef.current = persistNow;

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      // ANYTHING THAT IS NOT `active`, including iOS's `inactive` — the first
      // thing an incoming call raises, and not something to bet the wizard's
      // fields on waiting for `background` to follow.
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

  return { forgetOnSuccess, discardOnExit };
}
