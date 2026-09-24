import { createTattooAction } from "@/app/actions/tattoo";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { TattooForm } from "./TattooForm";

export default async function NewTattooPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const session = await requireOwnedPetByToken(publicToken);
  const { pet } = session;

  const boundAction = createTattooAction.bind(null, pet.publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <TattooForm action={boundAction} />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
