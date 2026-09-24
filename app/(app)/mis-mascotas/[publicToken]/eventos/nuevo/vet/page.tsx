import { VetPersonalChannelHint } from "@/components/pet-profile/VetPersonalChannelHint";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { createVetVisitAction } from "@/src/modules/events/actions";
import { VetVisitForm } from "./VetVisitForm";

export default async function NewVetVisitPage({
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

  const defaults = {
    occurredAt: sp.occurredAt ?? null,
    notes: sp.notes ?? null,
  };

  const boundAction = createVetVisitAction.bind(null, pet.publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        {/* #757 — said BEFORE the submit, where the surprise happens. */}
        <VetPersonalChannelHint userId={user.id} accessPath={accessPath} />
        <VetVisitForm action={boundAction} defaults={defaults} />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
