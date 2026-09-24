// The refusal a CARETAKER reads instead of a 404.
//
// WHY THIS COMPONENT EXISTS AT ALL
// ---------------------------------------------------------------------------
// `requirePetAccess` fails closed to notFound() and that is correct for its
// usual denial: someone who has no relationship to the pet must not learn
// whether it exists. A caretaker is the opposite case. They hold an active
// ownership row, they are looking at the animal in their care, and telling them
// "no existe" is a lie with nothing on the other side of it — no explanation,
// no way back, and no hint that the boundary was deliberate.
//
// `requireTitularAccess` returns the structural reason `not-titular` precisely
// so a page can branch here instead. Every use must name the refused action,
// say what the caretaker CAN still do, and leave a link back to the pet: a
// refusal that dead-ends teaches the person the product is broken.
//
// A server component on purpose — it has no state and every caller is an RSC.

import Link from "next/link";

import { LnCallout } from "@/components/ui/DocElements";
import { CARETAKER_SCOPE_ALLOWED } from "@/src/modules/caretakers/domain/grant-copy";

type Props = {
  petPublicToken: string;
  /** The refused action, in es-AR, as a noun phrase: "Registrar una mudanza". */
  what: string;
  /**
   * The guard's own message, when there is one. Preferred over inventing copy:
   * `requireTitularAccess` already writes the sentence, and two sources for one
   * refusal drift.
   */
  reason?: string;
};

export function NotTitularNotice({ petPublicToken, what, reason }: Props) {
  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      <LnCallout tone="warn" title={`${what}: solo la puede hacer el titular`}>
        {reason ? `${reason} ` : ""}
        Mientras dure el cuidado podés hacer lo importante del día a día:{" "}
        {lowerFirst(CARETAKER_SCOPE_ALLOWED)}
      </LnCallout>
      <Link
        href={`/mis-mascotas/${petPublicToken}`}
        className="mt-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        Volver a la libreta
      </Link>
    </div>
  );
}

/** "Podés cargar…" reads wrong mid-sentence; "podés cargar…" does not. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
