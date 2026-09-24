// `/mis-mascotas/{token}/eventos/atestar-raza-peligrosa` — the PPP attestation.
//
// GATED BY requireTitularAccess, NOT requireOwnedPetByToken. This is deny-list
// row `ppp-attestation` (T4-I1 / #753): the PPP registries inscribe the
// PROPIETARIO — Ley CABA 4078 + Res. 93/APRA/2021 (APrA via TAD, with the RC
// policy and the owner's own course) and Ley PBA 14.107 (Registro Provincial)
// — so the person who can truthfully say "está inscripta" is the titular. A
// caretaker holds a Path-1 ownership row and sailed straight through the old
// door. The action behind this form enforces the same gate; this is the half
// that stops a caretaker from ever seeing the control.
//
// A denied caretaker gets a SENTENCE, not a 404 — `NotTitularNotice`, for the
// reason that component's header states.

import { NotTitularNotice } from "@/components/pet-profile/NotTitularNotice";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import { createDangerousBreedAttestationAction } from "@/src/modules/events/actions";
import { notFound, redirect } from "next/navigation";
import { DangerousBreedAttestationForm } from "./DangerousBreedAttestationForm";

export default async function NewDangerousBreedAttestationPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) {
    if (access.reason === "no-session") {
      redirect(
        `/iniciar-sesion?returnTo=${encodeURIComponent(
          `/mis-mascotas/${publicToken}/eventos/atestar-raza-peligrosa`,
        )}`,
      );
    }
    if (access.reason === "not-titular") {
      return (
        <NotTitularNotice
          petPublicToken={publicToken}
          what="Atestar la inscripción en el registro PPP"
          reason={access.error}
        />
      );
    }
    notFound();
  }
  const { pet } = access;

  // Only relevant for pets flagged as potentially dangerous breed. Anyone else
  // bouncing to this URL gets sent back to the pet detail.
  if (!pet.potentiallyDangerousBreed) {
    redirect(`/mis-mascotas/${pet.publicToken}`);
  }
  if (pet.status === "deceased") {
    redirect(`/mis-mascotas/${pet.publicToken}`);
  }

  const boundAction = createDangerousBreedAttestationAction.bind(null, pet.publicToken);

  // Config-theater fix (handoff 2026-07-03 #1): resolve the
  // ppp_attestation_required_registries rule for the pet's own jurisdiction
  // so an admin-edited rule actually changes what the owner sees here.
  const resolvedRule = await resolveBusinessRule("ppp_attestation_required_registries", {
    country: "AR",
    province: pet.jurisdictionProvince,
    locality: pet.jurisdictionLocality,
  });

  return (
    <LnSheetWrap>
      <LnSheetCard>
        <DangerousBreedAttestationForm
          action={boundAction}
          resolvedRegistries={resolvedRule.payload.registries}
        />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
