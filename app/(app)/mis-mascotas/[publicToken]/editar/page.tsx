import { Icon } from "@/components/Icon";
import { PetForm } from "@/components/PetForm";
import { NotTitularNotice } from "@/components/pet-profile/NotTitularNotice";
import { LnSheetCard, LnSheetHeader, LnSheetWrap } from "@/components/ui/Sheet";
import { attachments, db } from "@/db";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { petPhotoUrl } from "@/lib/infra/storage";
import { updatePetAction } from "@/src/modules/pets/actions";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

export default async function EditPetPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  // requireTitularAccess, not requirePetAccess: editing name/species/breed/
  // date-of-birth is deny-list row `identity-field-edits`, and a caretaker
  // holds a Path-1 ownership row that sails through the looser guard. The
  // writer (updatePetAction) is already gated; this stops the FORM from
  // rendering, so the boundary is never something a person finds by filling in
  // a field and pressing save.
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) {
    if (access.reason === "not-titular") {
      return (
        <NotTitularNotice
          petPublicToken={publicToken}
          what="Editar los datos de la mascota"
          reason={access.error}
        />
      );
    }
    notFound();
  }
  const { pet } = access;

  // Photo: tiny side query indexed on primaryPhotoId.
  const [photo] = pet.primaryPhotoId
    ? await db.select().from(attachments).where(eq(attachments.id, pet.primaryPhotoId)).limit(1)
    : [];

  // ARCH-S: fetch canonical chip for pre-filling the form (pets.microchipId* dropped).
  const canonicalIds = await fetchActiveIdentifications(pet.id);

  // Jurisdiction-resolved PPP breed list so the inline "raza peligrosa" warning
  // flags breeds a locality ADDED via the admin console, not just the static
  // country-wide set (2026-07-04). Display-only; submit-time classification is
  // authoritative regardless.
  const pppBreedRule = await resolveBusinessRule("ppp_breed_list", {
    province: pet.jurisdictionProvince,
    locality: pet.jurisdictionLocality,
  });

  const boundAction = updatePetAction.bind(null, publicToken);

  return (
    <LnSheetWrap>
      <LnSheetCard wide>
        <LnSheetHeader
          tone="azul"
          icon={<Icon name="editar" decorative />}
          title={`Editar ${pet.name}`}
          subtitle="Cualquier cambio queda registrado en la libreta"
        />
        <div className="flex flex-col gap-3.5 px-[18px] py-[18px]">
          <Link
            href={`/mis-mascotas/${pet.publicToken}`}
            className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
          >
            ← Volver al perfil
          </Link>
          <PetForm
            action={boundAction}
            existingPet={pet}
            existingPhotoUrl={petPhotoUrl(photo?.storagePath)}
            existingCanonicalChip={
              canonicalIds.microchip
                ? {
                    code: canonicalIds.microchip.code,
                    isoCountryCode: canonicalIds.microchip.isoCountryCode,
                    recordedAt: canonicalIds.microchip.recordedAt,
                    recordedByLabel: canonicalIds.microchip.recordedByLabel,
                    implantationSite: canonicalIds.microchip.implantationSite,
                  }
                : null
            }
            pppBreedList={pppBreedRule.payload.breeds}
          />
        </div>
      </LnSheetCard>
    </LnSheetWrap>
  );
}
