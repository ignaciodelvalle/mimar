// The ENO diagnosis step of the clinical record (PO S2, 2026-09-26). Vet only:
// a person without a verified matrícula is sent back to the clinical form —
// the server action refuses them anyway (recordDiseaseDiagnosisAction).
//
// PO decision (2026-09-26, "Sí, sin distinción"): a verified vet reaching the
// animal through their OWN ownership still files the diagnosis as a vet. The
// gate is the matrícula, never the relation to the animal — do not add one.

import { redirect } from "next/navigation";

import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { isVerifiedVet } from "@/lib/infra/verified-vet";
import { recordDiseaseDiagnosisAction } from "@/src/modules/events/actions";

import { DiseaseDiagnosisForm } from "./DiseaseDiagnosisForm";

export default async function NewDiseaseDiagnosisPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const { pet, user } = await requireOwnedPetByToken(publicToken);
  if (!(await isVerifiedVet(user.id))) {
    redirect(`/mis-mascotas/${pet.publicToken}/eventos/nuevo/clinico`);
  }

  const boundAction = recordDiseaseDiagnosisAction.bind(null, pet.publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <DiseaseDiagnosisForm action={boundAction} species={pet.species} />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
