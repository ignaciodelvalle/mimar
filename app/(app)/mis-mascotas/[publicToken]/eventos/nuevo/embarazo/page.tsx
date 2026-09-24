// Pregnancy registration entry — spec 2026-05-19-pregnancy-tracking-design §5.2.
//
// Two phases:
//   - ?phase=started → open the pregnancy (default)
//   - ?phase=ended   → close with outcome (only when pet.pregnancyStatus='in_progress')
//
// Server-side gates:
//   - pet.sex must be 'female' and the species must have a known gestation
//   - phase=started requires pet.pregnancyStatus != 'in_progress'
//   - phase=ended requires pet.pregnancyStatus == 'in_progress'
//
// THE SPECIES SET USED TO BE A LITERAL HERE — `{dog, cat, other}`, from PR2 —
// and it went stale. The writer's `PREGNANCY_DURATION_DAYS` was widened on
// 2026-09-07 (PO decision) to cover every species in `PET_SPECIES`, because a
// rabbit, a guinea pig and a ferret all gestate and all were being refused. The
// phone's picker tracked that change; this page did not, so it kept refusing a
// pregnant rabbit the writer would have accepted. It now asks
// `speciesCanCarryPregnancy`, which reads the writer's own table.

import Link from "next/link";

import { recordPregnancyEndedAction, recordPregnancyStartedAction } from "@/app/actions/pregnancy";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { speciesCanCarryPregnancy } from "@/src/modules/pets/application/pregnancy/pregnancy-eligibility";

import { PregnancyEndedForm } from "./PregnancyEndedForm";
import { PregnancyStartedForm } from "./PregnancyStartedForm";

export default async function NewPregnancyPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{ phase?: string }>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  const phase = sp.phase === "ended" ? "ended" : "started";

  const session = await requireOwnedPetByToken(publicToken);
  const { pet } = session;

  if (pet.sex !== "female") {
    return (
      <BlockedShell
        publicToken={publicToken}
        message="Solo se pueden registrar embarazos en hembras."
      />
    );
  }
  if (!speciesCanCarryPregnancy(pet.species)) {
    return (
      <BlockedShell
        publicToken={publicToken}
        message="Esta especie no soporta el registro de embarazo."
      />
    );
  }
  if (phase === "started" && pet.pregnancyStatus === "in_progress") {
    return (
      <BlockedShell
        publicToken={publicToken}
        message="Esta mascota ya tiene un embarazo en seguimiento. Cerralo primero antes de registrar uno nuevo."
        showEndedLink
      />
    );
  }
  if (phase === "ended" && pet.pregnancyStatus !== "in_progress") {
    return (
      <BlockedShell
        publicToken={publicToken}
        message="No hay un embarazo activo para cerrar. Registrá primero el inicio."
      />
    );
  }

  const startedAction = recordPregnancyStartedAction.bind(null, pet.publicToken);
  const endedAction = recordPregnancyEndedAction.bind(null, pet.publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        {phase === "started" ? (
          <PregnancyStartedForm action={startedAction} />
        ) : (
          <PregnancyEndedForm action={endedAction} />
        )}
      </LnSheetCard>
    </LnSheetWrap>
  );
}

function BlockedShell({
  publicToken,
  message,
  showEndedLink,
}: {
  publicToken: string;
  message: string;
  showEndedLink?: boolean;
}) {
  return (
    <LnSheetWrap>
      <LnSheetCard>
        <div className="px-[18px] py-6 space-y-[12px]">
          <p className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] px-3 py-2.5 text-md text-[var(--color-ln-warn)]">
            {message}
          </p>
          {showEndedLink && (
            <Link
              href={`/mis-mascotas/${publicToken}/eventos/nuevo/embarazo?phase=ended`}
              className="inline-block rounded-[var(--radius-pill)] border border-[var(--color-ln-rosa)] bg-[var(--color-ln-rosa)] px-3.5 py-2 font-ln-mono text-sm font-semibold text-white"
            >
              Registrar cierre del embarazo
            </Link>
          )}
        </div>
      </LnSheetCard>
    </LnSheetWrap>
  );
}
