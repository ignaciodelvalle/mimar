import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import Link from "next/link";
import { ReplaceMicrochipForm } from "./ReplaceMicrochipForm";
import { replaceMicrochipOwnerAction } from "./action";

export default async function ReplaceMicrochipPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const session = await requireOwnedPetByToken(publicToken);
  const { pet } = session;

  const boundAction = replaceMicrochipOwnerAction.bind(null, pet.publicToken);
  const canonicalIds = await fetchActiveIdentifications(pet.id);

  if (!canonicalIds.microchip) {
    return (
      <LnSheetWrap>
        <LnSheetCard>
          <div className="px-[18px] py-6 space-y-[12px]">
            <p className="font-ln-serif text-base font-semibold text-[var(--color-ln-ink)]">
              Sin microchip registrado
            </p>
            <p className="text-md text-[var(--color-ln-mute)]">
              {pet.name} no tiene microchip registrado todavía. Para reemplazarlo primero tenés que
              registrar el chip original.
            </p>
            <Link
              href={`/mis-mascotas/${pet.publicToken}/eventos/nuevo/microchip`}
              className="inline-block rounded-[var(--radius-pill)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] px-3.5 py-2 font-ln-mono text-sm font-semibold text-white"
            >
              Registrar microchip implantado
            </Link>
          </div>
        </LnSheetCard>
      </LnSheetWrap>
    );
  }

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <ReplaceMicrochipForm action={boundAction} currentChip={canonicalIds.microchip.code} />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
