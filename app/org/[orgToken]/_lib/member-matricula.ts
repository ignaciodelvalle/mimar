// member-matricula — the acting member's professional-licence status, as a
// glanceable fact (D-9, Lote D).
//
// WHY: whether a vet's matrícula is VERIFIED decides how every clinical event
// they sign is recorded — verified by a professional, or merely declared. That
// is the single most consequential property of their account on this portal,
// and until now its only mention anywhere in the org landing was one subordinate
// clause inside the "Atender" module card's description: "Si tenés matrícula
// verificada, se firma como verificado por profesional." A conditional sentence
// in prose is not a status: it never says which side of the condition the reader
// is on. A vet whose matrícula was never submitted, and one whose submission is
// still queued for admin approval, read the landing identically — and both
// discover the difference only after signing an event that does not count.
//
// PURE module (no DB, no React) so the three states and their copy are asserted
// directly rather than through a page render.

export type MatriculaState = "verified" | "pending" | "missing";

export type MatriculaStatus = {
  state: MatriculaState;
  /** OpPill tone for the badge. */
  tone: "ok" | "open" | "neutral";
  /** Short es-AR badge text. */
  label: string;
  /** One sentence naming the CONSEQUENCE, not just the state. */
  detail: string;
  /** Where to resolve it, when there is anything to do. */
  href?: string;
};

/**
 * Derive the acting member's matrícula status.
 *
 * The three states are genuinely different, and collapsing any two of them is
 * the bug this fixes:
 *   - verified → the licence was checked; signatures carry professional weight.
 *   - pending  → submitted, waiting on an admin decision. Nothing for the vet to
 *     do but wait, so no CTA — an action link here would send them to a form
 *     they already completed.
 *   - missing  → never submitted. This is the only actionable one, and it is the
 *     one the old prose hid completely.
 *
 * A blank-but-present string counts as missing: a whitespace matrícula is not a
 * submission, and treating it as "pending" would promise a review nobody queued.
 */
export function deriveMatriculaStatus(input: {
  matriculaNumber: string | null;
  matriculaVerified: boolean;
}): MatriculaStatus {
  const number = input.matriculaNumber?.trim() ?? "";

  if (input.matriculaVerified && number.length > 0) {
    return {
      state: "verified",
      tone: "ok",
      label: `Matrícula verificada · ${number}`,
      detail: "Los eventos clínicos que registres se firman como verificados por profesional.",
    };
  }

  if (number.length > 0) {
    return {
      state: "pending",
      tone: "open",
      label: "Matrícula sin verificar",
      detail:
        "Tu matrícula está presentada y esperando aprobación. Hasta que se apruebe, lo que registres queda como declarado, no verificado.",
    };
  }

  return {
    state: "missing",
    tone: "neutral",
    label: "Sin matrícula cargada",
    detail:
      "Sin matrícula verificada, los eventos clínicos que registres quedan como declarados, no verificados por profesional.",
    href: "/cuenta/upgrade",
  };
}
