"use client";

// "Mandar a mi veterinaria" (v14, "Viaje en pasos", design pins 17-18 and 23).
//
// THE SAME PDF, THROUGH THE SAME SHARE. It generates the trip's PDF with the
// export action the "Exportar PDF" button uses (generateTravelExportAction —
// the use-case the native app's export calls too) and hands the signed link
// to the device's share sheet with a suggested message. No new model, no live
// data to the vet: the owner chooses who receives it and through which app.
// Sharing the trip itself with a vet needs the owner's consent (design D8,
// stage 1.5) and is not this.
//
// Without a share sheet (most desktop browsers) it offers WhatsApp, e-mail and
// the link itself — the same fallbacks the libreta's share uses.

import { useState, useTransition } from "react";

import { generateTravelExportAction } from "@/app/actions/travel-export";
import { LnButton } from "@/components/ui/Button";

export type TravelShareToVetProps = {
  petPublicToken: string;
  tripEventId: string;
  /** "Pampa". */
  petName: string;
  /** "Chile, 15/11/2026". */
  tripLabel: string;
  /** The button's words: "Mandar a mi veterinaria", "Pedírselo a mi veterinaria". */
  label: string;
  variant?: "ghost" | "primary";
  size?: "sm" | "md";
  block?: boolean;
};

/** The message the share sheet starts with. The owner edits it there. */
export function shareToVetText(petName: string, tripLabel: string): string {
  return `Hola, te paso los requisitos de viaje de ${petName} (${tripLabel}). ¿Me ayudás con lo que falta?`;
}

export function TravelShareToVet({
  petPublicToken,
  tripEventId,
  petName,
  tripLabel,
  label,
  variant = "ghost",
  size = "sm",
  block = false,
}: TravelShareToVetProps) {
  const [isPending, startTransition] = useTransition();
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = shareToVetText(petName, tripLabel);

  function handleShare() {
    setError(null);
    startTransition(async () => {
      const result = await generateTravelExportAction(petPublicToken, tripEventId);
      if (!result.ok) {
        setError("No pudimos preparar el PDF para mandar. Probá de nuevo en unos minutos.");
        return;
      }
      const share = typeof navigator !== "undefined" ? navigator.share : undefined;
      if (share) {
        try {
          await navigator.share({ title: `Viaje de ${petName}`, text, url: result.signedUrl });
          return;
        } catch {
          // Closed without choosing an app: offer the links instead.
        }
      }
      setFallbackUrl(result.signedUrl);
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <LnButton
        type="button"
        variant={variant}
        size={size}
        block={block}
        onClick={handleShare}
        loading={isPending}
      >
        {isPending ? "Preparando el PDF…" : label}
      </LnButton>
      {fallbackUrl && (
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`${text} ${fallbackUrl}`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-ln-azul)] underline"
          >
            Mandar por WhatsApp
          </a>
          <a
            href={`mailto:?subject=${encodeURIComponent(`Viaje de ${petName}`)}&body=${encodeURIComponent(`${text}\n\n${fallbackUrl}`)}`}
            className="text-[var(--color-ln-azul)] underline"
          >
            Mandar por correo
          </a>
          <a
            href={fallbackUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-ln-azul)] underline"
          >
            Abrir el PDF
          </a>
          <span className="text-xs text-[var(--color-ln-mute)]">(enlace válido por 24 horas)</span>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--color-ln-err)]">
          {error}
        </p>
      )}
    </div>
  );
}
