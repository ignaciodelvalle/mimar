import Link from "next/link";

import { VetPersonalChannelHint } from "@/components/pet-profile/VetPersonalChannelHint";
import { LnCallout } from "@/components/ui/DocElements";
import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";
import { requireOwnedPetByToken } from "@/lib/infra/pets";
import { isVerifiedVet } from "@/lib/infra/verified-vet";
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
  // PO S2 (2026-09-26): the ENO diagnosis is its own step, offered only to a
  // matriculated vet — the server refuses everyone else.
  const vet = await isVerifiedVet(user.id);

  return (
    <LnSheetWrap>
      <LnSheetCard>
        {/* #757 — said BEFORE the submit, where the surprise happens. */}
        <VetPersonalChannelHint userId={user.id} accessPath={accessPath} />
        {vet && (
          <LnCallout title="¿Diagnosticaste una enfermedad de notificación obligatoria?">
            Registrala como diagnóstico: abre el aviso a la autoridad sanitaria con su plazo legal.{" "}
            <Link
              href={`/mis-mascotas/${pet.publicToken}/eventos/nuevo/clinico/diagnostico`}
              className="font-semibold text-[var(--color-ln-azul)] underline"
            >
              Registrar diagnóstico
            </Link>
          </LnCallout>
        )}
        <ClinicalInfoForm action={boundAction} defaults={defaults} />
      </LnSheetCard>
    </LnSheetWrap>
  );
}
