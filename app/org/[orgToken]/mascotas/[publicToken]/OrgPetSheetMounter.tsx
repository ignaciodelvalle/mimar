"use client";

/**
 * OrgPetSheetMounter — deep-link driven sheets for the org pet detail page.
 *
 * Opens the appropriate form Sheet based on `?sheet=<id>` URL state.
 * Closing removes the `sheet` param from the URL via closeSheetNav (native
 * History API — router-hot-path fix, see lib/ui/sheet-nav.ts).
 *
 * Supported sheet IDs:
 *   elegibilidad | reemplazar-microchip | fin-transito | devolver-al-dueno
 *   vacuna | peso | nota (event recording — gated on `event.write`, bug 2
 *   staging validation 2026-07-04; forms + writers reused from the owner side,
 *   same precedent as AtenderCaptureMounter)
 *
 * Props are threaded from the server page so no client-side fetching is needed.
 */

import { Sheet } from "@/components/ui/VaulSheet";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav } from "@/lib/ui/sheet-nav";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { replaceMicrochipVetAction } from "@/app/org/[orgToken]/mascotas/[publicToken]/microchip/reemplazar/action";

import { NoteForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/nota/NoteForm";
import { WeightForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/peso/WeightForm";
import { VaccinationForm } from "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/vacuna/VaccinationForm";

import { ProposeReturnForm } from "./devolver-al-dueno/ProposeReturnForm";
import { EligibilityForm } from "./eligibility/EligibilityForm";
import {
  orgRecordNoteAction,
  orgRecordVaccinationAction,
  orgRecordWeightAction,
} from "./eventos/actions";
import { EndFosterForm } from "./foster-fin/EndFosterForm";
import { ReplaceMicrochipForm } from "./microchip/reemplazar/ReplaceMicrochipForm";

type EligibilityData = {
  eligible: boolean | null;
  reason: string | null;
  notes: string | null;
  until: string | null;
};

type Props = {
  orgToken: string;
  petPublicToken: string;
  petName: string;
  /** Pet species — the VaccinationForm needs it for the vaccine catalog. */
  petSpecies: string;
  /**
   * Member holds `event.write` — gates the nota sheet. The server actions
   * re-enforce this capability independently (pet-access.ts).
   */
  canWriteEvents: boolean;
  /**
   * event.write AND the pet is alive — gates vacuna/peso (their actions go
   * through requireAlivePetAccess; nota allows deceased pets, owner parity).
   */
  canRecordClinical: boolean;
  /** Adoption eligibility data for the EligibilityForm. */
  eligibility: EligibilityData;
  /** Current microchip ID — null if the pet has no microchip. */
  currentChip: string | null;
  /**
   * Active foster's display name — null when there is no active foster.
   * Sheet is gated on this being non-null.
   */
  fosterName: string | null;
  /**
   * Whether the devolver-al-dueno sheet should be available.
   * True only when: pet is lost, org has shelter_custody, no pending proposal.
   */
  canProposeReturn: boolean;
};

export function OrgPetSheetMounter({
  orgToken,
  petPublicToken,
  petName,
  petSpecies,
  canWriteEvents,
  canRecordClinical,
  eligibility,
  currentChip,
  fosterName,
  canProposeReturn,
}: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sheet = searchParams.get("sheet");

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    closeSheetNav(buildCloseSheetUrl(pathname, params));
  }, [pathname, searchParams]);

  if (sheet === "elegibilidad") {
    return (
      <Sheet
        id="elegibilidad"
        title={`Elegibilidad para adopción · ${petName}`}
        open
        onClose={close}
        size="lg"
      >
        <EligibilityForm
          petPublicToken={petPublicToken}
          orgToken={orgToken}
          current={eligibility}
        />
      </Sheet>
    );
  }

  if (sheet === "reemplazar-microchip") {
    if (!currentChip) {
      return (
        <Sheet
          id="reemplazar-microchip"
          title={`Reemplazar microchip · ${petName}`}
          open
          onClose={close}
        >
          <p className="text-md text-ln-op-ink-2">
            {petName} no tiene microchip registrado todavía. No hay chip que reemplazar.
          </p>
        </Sheet>
      );
    }
    const action = replaceMicrochipVetAction.bind(null, orgToken, petPublicToken);
    return (
      <Sheet
        id="reemplazar-microchip"
        title={`Reemplazar microchip · ${petName}`}
        open
        onClose={close}
        size="lg"
      >
        <ReplaceMicrochipForm action={action} currentChip={currentChip} />
      </Sheet>
    );
  }

  if (sheet === "fin-transito") {
    if (!fosterName) {
      return (
        <Sheet id="fin-transito" title={`Cerrar tránsito · ${petName}`} open onClose={close}>
          <p className="text-md text-ln-op-ink-2">
            {petName} no tiene un tránsito activo para cerrar.
          </p>
        </Sheet>
      );
    }
    return (
      <Sheet
        id="fin-transito"
        title={`Cerrar tránsito · ${petName}`}
        open
        onClose={close}
        size="lg"
      >
        <EndFosterForm orgToken={orgToken} publicToken={petPublicToken} fosterName={fosterName} />
      </Sheet>
    );
  }

  if (sheet === "devolver-al-dueno") {
    if (!canProposeReturn) {
      return (
        <Sheet id="devolver-al-dueno" title={`Devolver · ${petName}`} open onClose={close}>
          <p className="text-md text-ln-op-ink-2">
            Esta acción no está disponible para {petName} en este momento. La mascota debe estar en
            estado perdida y sin propuesta de devolución pendiente.
          </p>
        </Sheet>
      );
    }
    return (
      <Sheet id="devolver-al-dueno" title={`Devolver · ${petName}`} open onClose={close} size="lg">
        <ProposeReturnForm orgToken={orgToken} petPublicToken={petPublicToken} petName={petName} />
      </Sheet>
    );
  }

  // Event recording (bug 2, staging validation 2026-07-04) — owner-side forms
  // bound to org-scoped redirect adapters. UI-gated on event.write; the shared
  // server actions re-enforce the capability at the signing boundary.
  if (sheet === "vacuna" && canRecordClinical) {
    const action = orgRecordVaccinationAction.bind(null, orgToken, petPublicToken);
    return (
      <Sheet id="vacuna" title={`Registrar vacuna · ${petName}`} open onClose={close}>
        <VaccinationForm
          action={action}
          species={petSpecies}
          defaults={{ occurredAt: null, notes: null }}
        />
      </Sheet>
    );
  }

  if (sheet === "peso" && canRecordClinical) {
    const action = orgRecordWeightAction.bind(null, orgToken, petPublicToken);
    return (
      <Sheet id="peso" title={`Registrar peso · ${petName}`} open onClose={close}>
        <WeightForm action={action} defaults={{ kg: null, occurredAt: null, notes: null }} />
      </Sheet>
    );
  }

  if (sheet === "nota" && canWriteEvents) {
    const action = orgRecordNoteAction.bind(null, orgToken, petPublicToken);
    return (
      <Sheet id="nota" title={`Nota · ${petName}`} open onClose={close}>
        <NoteForm action={action} defaults={{ text: null, occurredAt: null }} />
      </Sheet>
    );
  }

  // Unknown or absent sheet param — render nothing.
  return null;
}
