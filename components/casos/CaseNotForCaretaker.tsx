// What a CARETAKER sees on a case they cannot read.
//
// Cases are titular-only in v1 (design F2, PO-accepted): `can_read_case` grants
// the subject-pet branch on `role='owner'`, and `lib/infra/case-access.ts`
// mirrors it. Widening a SECURITY DEFINER function that also governs welfare
// denuncias is a decision that deserves its own change and its own review.
//
// The limitation is fine. The way it USED to surface was not: LostCaseBlock and
// the open-case badges render on the pet a caretaker is looking after, and
// every one of those links hit notFound(). "This case does not exist" told to
// the person currently caring for the animal is both false and unrecoverable —
// there is nothing on a 404 to act on, and the natural conclusion is that the
// product is broken.
//
// The 404 stays for everyone else. Case existence must not leak to a stranger,
// and it does not: this screen only renders behind `holdsActiveCaretakerRow`,
// which is true only for someone with a live caretaker row on the subject pet.

import Link from "next/link";

import { LnCallout } from "@/components/ui/DocElements";

type Props = {
  /** Null when the case has no subject pet — the notice still renders. */
  petPublicToken: string | null;
  petName: string | null;
};

export function CaseNotForCaretaker({ petPublicToken, petName }: Props) {
  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      {/* The spec's own phrase, kept verbatim: "no disponible para cuidadores".
          It names the ROLE, so the reader understands this is a boundary that
          applies to their situation — not an error that happened to them. */}
      <LnCallout tone="warn" title="Caso no disponible para cuidadores">
        El expediente lo sigue el titular de la mascota, que es quien puede verlo y responder. Vos
        podés seguir cargando eventos médicos, notas y marcar perdido/encontrado mientras dure el
        cuidado.
      </LnCallout>
      {petPublicToken && (
        <Link
          href={`/mis-mascotas/${petPublicToken}`}
          className="mt-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          Volver a {petName ?? "la mascota"}
        </Link>
      )}
    </div>
  );
}
