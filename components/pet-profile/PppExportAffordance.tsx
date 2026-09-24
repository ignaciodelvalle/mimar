"use client";

// PppExportAffordance — the owner's way to emit the RUPPPA registration PDF
// (CABA's registry; its legal basis lives in lib/analytics/ppp-exports.ts — no
// citation is written in this module, see the fence in pet-compliance.test.ts)
// from the PPP card of the pet's compliance
// panel (L-11). generatePppExportAction existed complete — render, upload,
// signed URL, audit — and no component invoked it, so no PPP owner in CABA
// could reach the document.
//
// The page decides eligibility (lib/domain/ppp-export-eligibility.ts) and hands
// this component in as a SLOT; the compliance panel and CredentialFace never
// import the action, so their tests stay off the database graph.
//
// No window.open after the await: popup blockers eat it. The PDF arrives as a
// signed URL and the component turns into a plain download link.

import { useState, useTransition } from "react";

import { generatePppExportAction } from "@/app/actions/ppp-export-caba";
import { LnButton } from "@/components/ui/Button";
import type { PppExportAvailability } from "@/lib/domain/ppp-export-eligibility";

// The use-case's error codes, in the owner's words.
const ERROR_COPY: Record<string, string> = {
  not_found: "No encontramos esta mascota a tu nombre.",
  pet_not_ppp_for_jurisdiction: "Esta mascota no figura como potencialmente peligrosa.",
  ppp_prov_ba_not_implemented:
    "La constancia para el registro RUPPPA es de la Ciudad de Buenos Aires; para esta jurisdicción todavía no la emitimos.",
};
const GENERIC_ERROR = "No pudimos generar el PDF. Probá de nuevo en unos minutos.";

export function PppExportAffordance({
  petPublicToken,
  availability,
}: {
  petPublicToken: string;
  availability: PppExportAvailability;
}) {
  const [pending, startTransition] = useTransition();
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (availability.kind === "unavailable") {
    return (
      <p
        data-testid="ppp-export-unavailable"
        className="mt-1 font-ln-sans text-xs leading-relaxed text-[var(--color-ln-ink-2)]"
      >
        {availability.reason}
      </p>
    );
  }

  function emit() {
    setError(null);
    startTransition(async () => {
      const result = await generatePppExportAction(petPublicToken);
      if (!result.ok) {
        setError(ERROR_COPY[result.error] ?? GENERIC_ERROR);
        return;
      }
      setSignedUrl(result.signedUrl);
    });
  }

  if (signedUrl) {
    return (
      <div className="mt-1 space-y-1">
        <a
          href={signedUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-ln-sans text-sm font-semibold text-[var(--color-ln-azul)] underline"
        >
          Descargar la constancia RUPPPA (PDF)
        </a>
        <p className="font-ln-sans text-xs text-[var(--color-ln-mute)]">
          El enlace vale 24 horas. Después, generala de nuevo desde acá.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-1">
      <LnButton
        type="button"
        size="sm"
        variant="ghost"
        onClick={emit}
        disabled={pending}
        loading={pending}
        className="w-fit"
      >
        {pending ? "Generando el PDF…" : "Emitir constancia RUPPPA (PDF)"}
      </LnButton>
      <p className="font-ln-sans text-xs text-[var(--color-ln-mute)]">
        Formulario para inscribir a tu perro en el registro de la Ciudad.
      </p>
      {error && (
        <p role="alert" className="font-ln-sans text-xs text-[var(--color-ln-err)]">
          {error}
        </p>
      )}
    </div>
  );
}
