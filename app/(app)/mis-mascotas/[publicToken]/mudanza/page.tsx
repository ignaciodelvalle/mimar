import { Icon } from "@/components/Icon";
import { NotTitularNotice } from "@/components/pet-profile/NotTitularNotice";
import { LnSheetCard, LnSheetHeader, LnSheetWrap } from "@/components/ui/Sheet";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import { recordMoveAction } from "@/src/modules/pets/actions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MoveForm } from "./MoveForm";

export default async function MovePetPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  // requireTitularAccess: a move rewrites the pet's jurisdiction, which is
  // deny-list row `jurisdiction-change` — the one with a legal edge, since the
  // province decides which authority the animal answers to.
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) {
    if (access.reason === "not-titular") {
      return (
        <NotTitularNotice
          petPublicToken={publicToken}
          what="Registrar una mudanza"
          reason={access.error}
        />
      );
    }
    notFound();
  }
  const { pet } = access;

  const boundAction = recordMoveAction.bind(null, publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <LnSheetHeader
          tone="azul"
          icon={<Icon name="ubicacion" decorative />}
          title={`Mudanza de ${pet.name}`}
          subtitle="El movimiento queda registrado en la libreta"
        />
        <div className="flex flex-col gap-3.5 px-[18px] py-[18px]">
          <Link
            href={`/mis-mascotas/${pet.publicToken}/editar`}
            className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
          >
            ← Volver a editar
          </Link>
          <MoveForm
            action={boundAction}
            petName={pet.name}
            currentProvince={pet.jurisdictionProvince}
            currentLocality={pet.jurisdictionLocality}
          />
        </div>
      </LnSheetCard>
    </LnSheetWrap>
  );
}
