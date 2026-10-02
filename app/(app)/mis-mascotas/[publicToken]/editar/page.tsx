import { Icon } from "@/components/Icon";
import { PetForm } from "@/components/PetForm";
import { NotTitularNotice } from "@/components/pet-profile/NotTitularNotice";
import { LnSheetCard, LnSheetHeader, LnSheetWrap } from "@/components/ui/Sheet";
import { attachments, db } from "@/db";
import { canEditPetProfile } from "@/lib/domain/profile-editors";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { requireTitularAccess, resolvePetHasTitularFact } from "@/lib/infra/pet-access";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { petPhotoUrl } from "@/lib/infra/storage";
import { updatePetAction } from "@/src/modules/pets/actions";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

export default async function EditPetPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { publicToken } = await params;
  const { seccion } = await searchParams;

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
  // web = app (owner-pet-actions): the form for exactly the viewers who may save
  // it (`canEditPetProfile`, the rule `updatePetAction` and the app read). A
  // user-held custody row and the org path pass the titular gate above but not
  // this one; they hold or reach the animal, so a 404 would be a lie — the
  // profile is where "Editar datos" shows them its reason.
  // The vecino en tránsito (user-held custody) edits only while the animal has
  // no titular (PO 2026-10-01) — the fact read from the rows, never the client.
  const petHasTitular = await resolvePetHasTitularFact({
    accessPath: access.accessPath,
    holderRole: access.holderRole,
    petId: access.pet.id,
  });
  if (!canEditPetProfile(access.accessPath, access.holderRole, petHasTitular)) {
    redirect(`/mis-mascotas/${publicToken}`);
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
            // The same two inputs the profile's sheet hands the form: Contactos
            // opens the emergency sheet for the titular alone (the contacts are
            // theirs), and a `seccion` in the link is scrolled into view.
            contactsHref={
              access.accessPath === "owner" && access.holderRole === "owner"
                ? `/mis-mascotas/${pet.publicToken}?sheet=emergencia`
                : null
            }
            initialSection={typeof seccion === "string" ? seccion : null}
          />
        </div>
      </LnSheetCard>
    </LnSheetWrap>
  );
}
