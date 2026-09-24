// Embeddable section that surfaces open cases for a pet.
//
// Renders nothing when the pet has no open cases — keeps the host page
// quiet by default. When open cases exist, sits above the libreta and
// each row links to /casos/[publicCode] via CaseBadge.

import { CaseBadge } from "@/components/CaseBadge";
import { findOpenCasesForPetWithCodes } from "@/lib/infra/case-queries";

interface Props {
  petId: string;
}

export async function PetOpenCasesSection({ petId }: Props) {
  const openCases = await findOpenCasesForPetWithCodes(petId);
  if (openCases.length === 0) return null;

  return (
    <section className="mb-6 rounded-2xl border border-ln-warn bg-[var(--color-ln-warn-050)] p-5  ">
      <header className="mb-3 flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-ln-ink ">
          Casos abiertos {openCases.length > 1 ? `(${openCases.length})` : ""}
        </h2>
        <span className="text-xs text-ln-mute ">
          Procedimientos activos que esta mascota tiene abiertos en miMAR
        </span>
      </header>
      <ul className="flex flex-wrap gap-2">
        {openCases.map((c) => (
          <li key={c.id}>
            <CaseBadge publicCode={c.publicCode} caseKind={c.caseKind} status={c.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
