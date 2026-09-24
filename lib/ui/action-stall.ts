// action-stall — the honest answer to a post-action navigation that never
// arrives (A14 / PO decision D.12, 2026-07-30).
//
// THE DEFECT THIS COVERS (not a fix — a NOISY FAILURE)
// A vet submits a clinical form on /org/[orgToken]/atender/[publicToken]. The
// server action COMMITS (verified against pet_events: the row is there, with
// author_role=vet and author_verified=t) and answers with the N3 contract's
// `redirectTo`. On a measured 25-40% of submits — and on ~90% of them when the
// page also renders PendingSignaturesCard — the browser never navigates:
// React's fiber root is left with pendingLanes == suspendedLanes == warmLanes
// and pingedLanes == 0, so `useActionState` never receives the result,
// `isPending` stays true, and the CTA reads "Registrando…" forever.
//
// The damage is not the stall. It is that a vet with no confirmation SIGNS
// AGAIN, and under invariant #2 (events are append-only) the duplicate row in a
// legally-weighted health record can never be removed.
//
// WHAT THIS MODULE IS ALLOWED TO SAY
// The root cause is not found yet, so the copy must not pretend otherwise:
//   - it must NOT claim the action failed — it usually SUCCEEDED;
//   - it must NOT claim the action succeeded — we genuinely do not know;
//   - it must NOT auto-retry (a retry is exactly the duplicate);
//   - it MUST send the operator to the record to look before acting again.
// Declaring "we could not confirm" is the only true statement available, and
// it is strictly better than an eternal "Registrando…", which reads as "still
// working" and invites the second click.
//
// NOT DONE HERE, DELIBERATELY: a server-side guard rejecting a second signature
// of the same act. That is new domain logic on a surface A13 already touched
// today (see atender-declared-events.rejectIfAlreadySigned) — PO ruling D.12.

/**
 * How long a submit may stay pending before we stop implying progress.
 *
 * The action itself answers in well under a second locally and in a couple of
 * seconds over a bad mobile link; a genuine upload (AttachmentField) is the
 * slowest legitimate case. 8s is comfortably past all of them and still far
 * short of the patience a stalled vet actually has.
 */
export const ACTION_STALL_MS = 8000;

/**
 * Copy per surface. Two variants because "firma" is the vet's word on atender
 * and means nothing on the adoption screen — the SHAPE of the sentence is the
 * contract, not the noun: we could not confirm → it may well have been saved →
 * go look before you do it again → doing it again duplicates it permanently.
 */
export const ACTION_STALL_COPY = {
  signature: {
    title: "No pudimos confirmar la firma",
    body: "Puede que haya quedado registrada igual. Revisá la libreta de la mascota antes de volver a firmar: si el registro ya está, firmar de nuevo lo duplica y no se puede borrar.",
  },
  adoption: {
    title: "No pudimos confirmar la adopción",
    body: "Puede que haya quedado registrada igual. Revisá la ficha de la mascota antes de volver a finalizar: si el registro ya está, finalizar de nuevo lo duplica y no se puede borrar.",
  },
} as const;

export type ActionStallSurface = keyof typeof ACTION_STALL_COPY;

/**
 * Is a submit inside `root` STILL pending?
 *
 * Read off the DOM rather than off React state on purpose: the atender surface
 * mounts six different owner-flow forms (AtenderCaptureMounter) that live
 * outside this feature's territory and each own their own `useActionState`.
 * The one thing they all publish is the pending state of their submit control —
 * LnSheetFooter renders `aria-busy` on it and disables it — so the wrapper can
 * observe every one of them without any of them changing.
 *
 * The three signals are OR-ed because they degrade independently: `aria-busy`
 * is the intended one, a disabled submit button is the fallback for controls
 * that never got `aria-busy`, and `[disabled][form]` covers the footer's
 * out-of-form button wired by `form=`.
 */
export function hasPendingSubmit(root: ParentNode | null | undefined): boolean {
  if (!root) return false;
  return (
    root.querySelector(
      '[aria-busy="true"], button[type="submit"][disabled], button[form][disabled]',
    ) !== null
  );
}
