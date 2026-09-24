// The trigger content for the panorama scope disclosure (the "alcance" pill).
//
// WHY THIS IS ITS OWN FILE: PanoramaConsole is already over the file-size
// ratchet's budget, and the fence's instruction is to split rather than feed it.
// This is a genuinely separable presentational piece with a rationale worth
// keeping next to it.
//
// WHAT IT IS: the operator's ONLY entry point to the province → locality drill.
// The panel behind it starts CLOSED (PO decision 2026-07-29), so whatever this
// pill communicates is the entire affordance.
//
// THE BUG IT CARRIES THE FIX FOR (C.4): it used to render
// "◉ <jurisdictions> ▾" with the word "Alcance" marked sr-only. Assistive tech
// therefore heard a named control while a sighted operator saw only a VALUE —
// the pill read as a status label. That asymmetry is what the panorama review
// meant by "no visible way to drill": the affordance was real, and it announced
// itself as a caption. The review was right about the symptom and wrong about
// the cause, which is why the first pass retracted the finding instead of
// fixing it.
//
// So the verb is VISIBLE next to the caret and also LEADS the accessible name,
// while the current scope stays on the chip — naming the act must not cost the
// operator the state, because that scope filters every number on the screen.
//
// Worth auditing elsewhere: an sr-only label over a control whose only visible
// text is its VALUE produces exactly this silent split between what assistive
// tech announces and what a sighted user sees.

/** Trigger content for the scope disclosure. `scopeLabel` is the live scope. */
export function ScopePillSummary({ scopeLabel }: { scopeLabel: string }) {
  return (
    <>
      <span aria-hidden="true">◉</span>
      <span className="sr-only">Cambiar alcance. Actualmente:</span>
      {scopeLabel}
      <span
        aria-hidden="true"
        className="ml-0.5 font-normal text-xs underline decoration-dotted underline-offset-2"
      >
        Cambiar
      </span>
      <span aria-hidden="true" className="text-xs">
        ▾
      </span>
    </>
  );
}
