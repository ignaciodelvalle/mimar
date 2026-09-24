"use client";

// Clinical-event capture for the walk-in signing surface.
//
// Reads `?evento=` and mounts the matching EXISTING owner-flow clinical form
// (reused verbatim — presentation only), bound to the org-scoped atender
// action. The action carries the #43 provenance via resolveAtenderPet; the
// form is unaware it is signing a non-custody event. On success each form
// performs the full-document redirect returned by the action (N3 contract),
// landing back on this surface with ?firmado=1.
//
// Slot prefill (#5): AtenderQuickCapture and PendingSignaturesCard both land
// here via extra searchParams (vaccineName, product, text, chipNumber,
// occurredAt…) — read once and threaded into each form's own `defaults`
// prop, the SAME mechanism VaccinationForm's `initialVaccineName` already
// used for a single field before this change.
//
// The vaccine catalog HARD GATE (#5, PO decision) wraps VaccinationForm via
// AtenderVaccinationGate — VaccinationForm itself is untouched.
//
// esterilizacion (#3) is reachable ONLY through PendingSignaturesCard's
// "Confirmar y firmar" CTA — never the ¿Qué querés registrar? grid. It lets a
// matriculated vet sign an owner-DECLARED esterilización event in-system, not
// log a fresh one from atender. `confirmEventId` travels as a bound
// server-action argument (not a form field) so the client cannot forge which
// declared event a signature targets.
//
// chip left that restriction on 2026-08-06 (PO decision, Cowork QA v3 M3):
// vets are the ones who implant and register microchips, so the grid now
// offers "Colocación de microchip" as a FRESH placement (confirmEventId
// null); the PendingSignaturesCard confirm path keeps working unchanged for
// owner-declared chips.
import { useSearchParams } from "next/navigation";

import { LnSheetCard, LnSheetWrap } from "@/components/ui/Sheet";

import { DewormingForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/antiparasitario/DewormingForm";
import { ClinicalInfoForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/clinico/ClinicalInfoForm";
import { SterilizationForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/esterilizacion/SterilizationForm";
import { MedicationStartForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/medicacion-inicio/MedicationStartForm";
import { MicrochipForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/microchip/MicrochipForm";
import { NoteForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/nota/NoteForm";

import {
  atenderClinicalInfoAction,
  atenderDewormingAction,
  atenderMedicationStartAction,
  atenderMicrochipAction,
  atenderNoteAction,
  atenderSterilizationAction,
  atenderVaccinationAction,
} from "../actions";
import { AtenderStallNotice } from "./AtenderStallNotice";
import { AtenderVaccinationGate } from "./AtenderVaccinationGate";

// ATENDER_EVENTOS + AtenderEvento moved to ./atender-eventos (server-safe) so
// the Server Component page.tsx can import the array without the client-boundary
// proxy that crashed `.map` (val-4-org blocker).

export function AtenderCaptureMounter({
  orgToken,
  publicToken,
  species,
  signerVerified,
}: {
  orgToken: string;
  publicToken: string;
  species: string;
  /** signer.matriculaVerified from resolveAtenderPet — display-only: decides
   * whether the vaccine form suppresses its owner-facing "dato declarado"
   * callout (false and contradictory under a verified signature). */
  signerVerified?: boolean;
}) {
  const searchParams = useSearchParams();
  const evento = searchParams.get("evento");
  const sp = (key: string) => searchParams.get(key) ?? null;

  if (!evento) return null;

  let form: React.ReactNode = null;

  if (evento === "vacuna") {
    const action = atenderVaccinationAction.bind(null, orgToken, publicToken);
    form = (
      <AtenderVaccinationGate
        action={action}
        species={species}
        initialVaccineName={sp("vaccineName") ?? undefined}
        signedContext={signerVerified === true}
      />
    );
  } else if (evento === "desparasitacion") {
    const action = atenderDewormingAction.bind(null, orgToken, publicToken);
    form = (
      <DewormingForm
        action={action}
        defaults={{ product: sp("product"), occurredAt: sp("occurredAt"), notes: null }}
      />
    );
  } else if (evento === "cirugia") {
    const action = atenderClinicalInfoAction.bind(null, orgToken, publicToken);
    form = (
      <ClinicalInfoForm action={action} defaults={{ occurredAt: sp("occurredAt"), notes: null }} />
    );
  } else if (evento === "medicacion") {
    const action = atenderMedicationStartAction.bind(null, orgToken, publicToken);
    form = (
      <MedicationStartForm
        action={action}
        species={species}
        defaultOccurredAt={sp("occurredAt") ?? undefined}
      />
    );
  } else if (evento === "nota") {
    const action = atenderNoteAction.bind(null, orgToken, publicToken);
    form = (
      <NoteForm action={action} defaults={{ text: sp("text"), occurredAt: sp("occurredAt") }} />
    );
  } else if (evento === "chip") {
    const action = atenderMicrochipAction.bind(null, orgToken, publicToken, sp("confirmEventId"));
    form = (
      <MicrochipForm
        action={action}
        defaults={{
          chipNumber: sp("chipNumber"),
          occurredAt: sp("occurredAt"),
          notes: sp("notes"),
        }}
      />
    );
  } else if (evento === "esterilizacion") {
    const action = atenderSterilizationAction.bind(
      null,
      orgToken,
      publicToken,
      sp("confirmEventId"),
    );
    form = (
      <SterilizationForm
        action={action}
        defaults={{ occurredAt: sp("occurredAt"), notes: null, procedure: sp("procedure") }}
      />
    );
  } else {
    return null;
  }

  return (
    <LnSheetWrap>
      <LnSheetCard>
        {/* D.12 noisy failure: when the post-action navigation is dropped the
            CTA is stuck on "Registrando…" forever and the vet signs again,
            duplicating a row in an append-only health record. See
            lib/ui/action-stall.ts. */}
        <AtenderStallNotice href={`/org/${orgToken}/atender/${publicToken}`}>
          {form}
        </AtenderStallNotice>
      </LnSheetCard>
    </LnSheetWrap>
  );
}
