"use client";

/**
 * CuentaSheetMounter — deep-link driven sheets for the cuenta dashboard.
 *
 * Opens the appropriate form Sheet based on `?sheet=<id>` URL state.
 * Closing removes the `sheet` param from the URL via closeSheetNav (native
 * History API — router-hot-path fix, see lib/ui/sheet-nav.ts).
 *
 * Supported sheet IDs:
 *   editar-perfil | renunciar-rol | solicitar-upgrade-vet | verificar-dni
 *
 * Flows deferred (too complex for a sheet in this slice):
 *   desactivar — requires per-locality coverage data fetched server-side
 *   ofrecerme-como-transito — 3-step wizard with complex controlled state
 *   crear-consultorio — 3-step wizard
 *   privacidad — destructive (account erasure); better as a full page
 */

import { Sheet } from "@/components/ui/VaulSheet";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav } from "@/lib/ui/sheet-nav";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { EditProfileForm } from "./editar/EditProfileForm";
import { VetSelfResignForm } from "./renunciar/VetSelfResignForm";
import { VetUpgradeForm } from "./upgrade/VetUpgradeForm";
import { DniVerifyForm } from "./verificar-dni/DniVerifyForm";

type InitialProfile = {
  displayName: string;
  phone: string;
  /** A short-lived SIGNED URL for preview — see EditProfileForm's copy of this type. */
  avatarUrl: string;
  preferredVetName: string;
  preferredVetPhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
};

type Props = {
  /** Profile fields needed by the editar-perfil sheet. */
  initialProfile: InitialProfile;
  /** Role gates — controls which sheets are available. */
  role: string;
  /** Whether the user's DNI is already verified (gates verificar-dni). */
  dniVerified: boolean;
};

export function CuentaSheetMounter({ initialProfile, role, dniVerified }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sheet = searchParams.get("sheet");

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    closeSheetNav(buildCloseSheetUrl(pathname, params));
  }, [pathname, searchParams]);

  if (sheet === "editar-perfil") {
    return (
      <Sheet
        id="editar-perfil"
        title="Editar mi información"
        description="Actualizá tu nombre, teléfono y foto de perfil."
        open
        onClose={close}
        size="lg"
      >
        <EditProfileForm initialProfile={initialProfile} />
      </Sheet>
    );
  }

  if (sheet === "renunciar-rol") {
    if (role !== "vet") return null;
    return (
      <Sheet
        id="renunciar-rol"
        title="Renunciar a rol veterinario/a"
        description="Al renunciar volvés a tener rol de dueño/a."
        open
        onClose={close}
      >
        <VetSelfResignForm />
      </Sheet>
    );
  }

  if (sheet === "solicitar-upgrade-vet") {
    // Owner-only: matches the trigger card's visibility. Without this, a
    // govt/admin could deep-link the sheet and submit a vet-upgrade request
    // (the server action only rejects role === "vet", not other non-owners).
    if (role !== "owner") return null;
    return (
      <Sheet
        id="solicitar-upgrade-vet"
        title="Convertirme en profesional"
        description="Registrá tu matrícula veterinaria o creá una organización."
        open
        onClose={close}
        size="lg"
      >
        <VetUpgradeForm dniVerified={dniVerified} />
      </Sheet>
    );
  }

  if (sheet === "verificar-dni") {
    // No-op only when there is nothing left to do. `dniVerified` alone was the
    // condition and the /cuenta affordance branched on `dniLast4`, so the two
    // disagreed on the seed's half-state and the button opened nothing (master
    // test CIU, N2b). The page now offers this sheet iff `!dniVerified`, so this
    // guard and that affordance are the same predicate read from two places.
    if (dniVerified) return null;
    return (
      <Sheet
        id="verificar-dni"
        title="Declarar DNI"
        description="Declará tu número de documento para verificar tu identidad."
        open
        onClose={close}
      >
        <DniVerifyForm next="/cuenta" />
      </Sheet>
    );
  }

  // Unknown or absent sheet param — render nothing.
  return null;
}
