import { VetPersonalChannelHint } from "@/components/pet-profile/VetPersonalChannelHint";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { createDewormingAction } from "@/src/modules/events/actions-medical";
import { DewormingForm } from "./DewormingForm";

export default async function NewDewormingPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{ product?: string; occurredAt?: string; notes?: string }>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  const session = await requireOwnedPetByToken(publicToken);
  const { pet, user, accessPath } = session;

  const defaults = {
    product: sp.product ?? null,
    occurredAt: sp.occurredAt ?? null,
    notes: sp.notes ?? null,
  };

  const boundAction = createDewormingAction.bind(null, pet.publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        {/* #757 — said BEFORE the submit, where the surprise happens. */}
        <VetPersonalChannelHint userId={user.id} accessPath={accessPath} />
        <DewormingForm action={boundAction} defaults={defaults} />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
