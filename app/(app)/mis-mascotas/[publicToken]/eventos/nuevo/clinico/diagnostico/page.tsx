// The ENO diagnosis step of the clinical record (PO S2, 2026-09-26). Vet only:
// a person without a verified matrícula is sent back to the clinical form —
// the server action refuses them anyway (recordDiseaseDiagnosisAction).

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
