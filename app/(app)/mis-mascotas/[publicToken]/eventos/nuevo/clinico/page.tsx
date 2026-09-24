import { VetPersonalChannelHint } from "@/components/pet-profile/VetPersonalChannelHint";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { createClinicalInfoAction } from "@/src/modules/events/actions";
import { ClinicalInfoForm } from "./ClinicalInfoForm";

export default async function NewClinicalInfoPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{ occurredAt?: string; notes?: string }>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  const session = await requireOwnedPetByToken(publicToken);
  const { pet, user, accessPath } = session;

  // Captura-rápida URL-prefill slots (event-capture-registry).
  const defaults = {
    occurredAt: sp.occurredAt ?? null,
    notes: sp.notes ?? null,
  };

  const boundAction = createClinicalInfoAction.bind(null, pet.publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        {/* #757 — said BEFORE the submit, where the surprise happens. */}
        <VetPersonalChannelHint userId={user.id} accessPath={accessPath} />
        <ClinicalInfoForm action={boundAction} defaults={defaults} />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
