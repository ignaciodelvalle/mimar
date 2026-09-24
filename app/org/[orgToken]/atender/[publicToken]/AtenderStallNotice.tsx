"use client";

// AtenderStallNotice — the D.12 noisy failure for the walk-in signing surface.
//
// WHY THIS IS A WRAPPER AND NOT A PROP ON EACH FORM
// AtenderCaptureMounter mounts six owner-flow clinical forms verbatim
// (MicrochipForm, NoteForm, …). They live under app/(app)/mis-mascotas and are
// shared with the owner journey; each owns its own `useActionState`, so their
// `isPending` is not reachable from here. What every one of them DOES publish
// is the pending state of its submit control (LnSheetFooter sets `aria-busy`
// and `disabled`). Watching the subtree therefore covers all six without
// touching a single shared form.
//
// The timer starts on the native `submit` event, in the CAPTURE phase, so it is
// armed before React's own root-level handler runs the action. A form that
// fails HTML validation never dispatches `submit`, so it never arms this.
//
// ⚠ `onSubmitCapture` IS LOAD-BEARING BEYOND THE TIMER — DO NOT REMOVE IT.
// Registering a capture-phase `submit` listener above the form is what stops
// the A14 wedge itself. Measured on DIM-DEMO-0002 (production build, 16 trials
// per arm, back-to-back builds, batches interleaved with a rate-limit reset):
//
//   nothing above the form (the shipped baseline) ......  0/16 navigated
//   an extra bare <div> around the form ................  0/16 navigated
//   THIS component, state + ref, handler removed .......  0/16 navigated
//   THIS component exactly as written ..................  16/16 navigated
//
// So it is not the extra host element and not the extra client component: it is
// the capture-phase listener. What that changes inside React's event system is
// NOT established — we can name the cause, not yet the reason — so treat the
// prop as a fix under observation, not as decoration on a notice. If someone
// "simplifies" it away, the vet is back to signing twice into an append-only
// health record, and nothing in the type system will say so. The tests in
// AtenderStallNotice.test.tsx fail loudly if the handler stops being wired.
//
// The notice below is the belt to that braces: the wedge is a race, this fix is
// measured on one surface and one build, and D.12 asks for a truthful failure
// even if the fix regresses.
//
// See lib/ui/action-stall.ts for what the notice is allowed to claim and why.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { ACTION_STALL_COPY, ACTION_STALL_MS, hasPendingSubmit } from "@/lib/ui/action-stall";

export function AtenderStallNotice({
  href,
  children,
}: {
  /** Where to send the vet to LOOK before signing again (a plain document GET —
   * never a re-submit). */
  href: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stalled, setStalled] = useState(false);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const onSubmitCapture = useCallback(() => {
    clear();
    // A fresh attempt retracts the previous verdict: we are back to "in
    // progress", not "still unconfirmed".
    setStalled(false);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Only accuse the surface of stalling if the control is STILL busy. A
      // slow-but-successful action navigates the whole document away and this
      // never runs; a server-side validation error clears the pending state
      // and renders its own message, and that is not a stall.
      if (hasPendingSubmit(rootRef.current)) setStalled(true);
    }, ACTION_STALL_MS);
  }, [clear]);

  return (
    // Passive observation of a bubbling form event, not an interactive control:
    // there is nothing here for a keyboard user to reach, and the wrapper adds
    // no role of its own.
    <div ref={rootRef} onSubmitCapture={onSubmitCapture}>
      {stalled && (
        <div
          role="alert"
          className="mb-3 rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-4 py-3"
        >
          <p className="text-md font-semibold text-ln-op-warn">
            {ACTION_STALL_COPY.signature.title}
          </p>
          <p className="mt-1 text-sm text-ln-op-warn">{ACTION_STALL_COPY.signature.body}</p>
          <p className="mt-2">
            {/* A hard document GET on purpose: the router transition is exactly
                what is broken here, so `next/link` is not a safe way out. */}
            <a href={href} className="text-sm font-semibold text-ln-op-warn underline">
              Volver a la ficha de esta mascota
            </a>
          </p>
        </div>
      )}
      {children}
    </div>
  );
}
