import { Icon } from "@/components/Icon";
import { NotTitularNotice } from "@/components/pet-profile/NotTitularNotice";
import { LnSheetCard, LnSheetHeader, LnSheetWrap } from "@/components/ui/Sheet";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import { correctPetSpeciesAction } from "@/src/modules/pets/actions";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CorrectSpeciesForm } from "./CorrectSpeciesForm";

export default async function CorrectSpeciesPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  // requireTitularAccess: species is an identity field (deny-list row
  // `identity-field-edits`), and correcting it rewrites what the animal IS.
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) {
    if (access.reason === "not-titular") {
      return (
        <NotTitularNotice
          petPublicToken={publicToken}
          what="Corregir la especie"
          reason={access.error}
        />
      );
    }
    notFound();
  }
  const { pet } = access;

  const boundAction = correctPetSpeciesAction.bind(null, publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <LnSheetHeader
          tone="azul"
          icon={<Icon name="editar" decorative />}
          title="Corregir especie"
          subtitle="La corrección queda registrada en la libreta"
        />
        <div className="flex flex-col gap-3.5 px-[18px] py-[18px]">
          <Link
            href={`/mis-mascotas/${pet.publicToken}/editar`}
            className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
          >
            ← Volver a editar
          </Link>
          <CorrectSpeciesForm
            action={boundAction}
            currentSpecies={pet.species}
            petName={pet.name}
          />
        </div>
      </LnSheetCard>
    </LnSheetWrap>
  );
}
