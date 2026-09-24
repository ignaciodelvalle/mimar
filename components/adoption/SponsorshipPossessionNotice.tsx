// SponsorshipPossessionNotice — the one sentence every org-facing screen
// repeats about a sponsored pet (rehome-by-titular, spec REQ-11).
//
// A rehome sponsorship gives the org a `shelter_custody` row while the animal
// keeps living with its family: registry custody, not possession. Every other
// `shelter_custody` row in the system means the org has the animal, and every
// org screen was written on that assumption — so each one that lets a member
// act on a sponsored pet (case detail, the applications queue, applicant
// review, the org's pet ficha, finalize) says this, persistently, in the same
// words. The PO's condition for accepting the "custodia means two things"
// overload was exactly this sentence.
//
// Pure presentation: the caller decides "sponsored" on the SPINE
// (`findOpenSponsorship` / `listOpenSponsorshipPetIds`), never on the
// owner+shelter_custody shape, which also describes a decomiso or an intake.
// Two surfaces because the org console and the citizen chrome use different
// token families; the words are identical (pinned by
// __tests__/rehome-possession-disclosure.test.tsx).

type Props = {
  petName: string;
  orgDisplayName: string;
  /** `op` for the org console (ln-op-* tokens), `ln` for the citizen/case chrome. */
  surface: "op" | "ln";
};

export function SponsorshipPossessionNotice({ petName, orgDisplayName, surface }: Props) {
  const lead = `${petName} vive con su familia; ${orgDisplayName} acompaña la adopción.`;
  const body = `No está en poder de ${orgDisplayName}: sigue en la casa de su titular hasta que se concrete la adopción. Solo el titular puede dar de baja el acompañamiento.`;

  if (surface === "op") {
    return (
      <div
        role="note"
        data-section="sponsorship-possession-notice"
        className="rounded-[var(--radius-md)] border border-ln-op-line border-l-[3px] border-l-ln-op-azul bg-ln-op-card px-4 py-3.5"
      >
        <p className="text-md font-bold text-ln-op-ink">{lead}</p>
        <p className="mt-0.5 text-sm leading-[1.5] text-ln-op-ink-2">{body}</p>
      </div>
    );
  }

  return (
    <div
      role="note"
      data-section="sponsorship-possession-notice"
      className="rounded-[var(--radius-sm)] border border-ln-celeste-100 px-4 py-3"
      style={{
        background: "var(--color-ln-celeste-050)",
        borderLeft: "3px solid var(--color-ln-azul)",
      }}
    >
      <p className="text-md font-semibold text-ln-ink">{lead}</p>
      <p className="mt-0.5 text-md leading-[1.5] text-ln-ink-2">{body}</p>
    </div>
  );
}
