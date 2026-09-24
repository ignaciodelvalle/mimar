"use client";

import { Sheet } from "@/components/ui/VaulSheet";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav } from "@/lib/ui/sheet-nav";
import { usePathname, useSearchParams } from "next/navigation";

// "Consulta sin turno" — for offerings flagged requiresAppointment=false.
// Surfaces phone + hours + address so the visitor can drop by directly.
// Handoff P2-9.
//
// In v1 we don't have a structured "horarios" column on organizations;
// the sheet shows whatever channels are available and a generic copy.
// When the schedule lookup lands, this becomes the canonical surface
// for it.

interface Props {
  orgDisplayName: string;
  orgEmail: string | null;
  orgPhone: string | null;
  jurisdictionLabel: string | null;
}

export function ConsultaSinTurnoSheet({
  orgDisplayName,
  orgEmail,
  orgPhone,
  jurisdictionLabel,
}: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const open = searchParams.get("sheet") === "consulta-sin-turno";

  return (
    <Sheet
      id="consulta-sin-turno"
      title="Consulta sin turno"
      open={open}
      onClose={() => closeSheetNav(buildCloseSheetUrl(pathname, searchParams))}
      size="sm"
    >
      <div className="space-y-4 text-sm text-[var(--color-ln-ink-2)]">
        <p>
          Este servicio no requiere turno previo. Contactá directamente con {orgDisplayName} para
          coordinar el día y la hora.
        </p>

        <div className="space-y-2">
          {orgPhone && (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3">
              <p className="text-xs uppercase tracking-wider text-[var(--color-ln-mute)]">
                Teléfono
              </p>
              <a
                href={`tel:${orgPhone}`}
                className="text-base text-[var(--color-ln-azul)] underline"
              >
                {orgPhone}
              </a>
            </div>
          )}
          {orgEmail && (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3">
              <p className="text-xs uppercase tracking-wider text-[var(--color-ln-mute)]">Email</p>
              <a
                href={`mailto:${orgEmail}`}
                className="text-base text-[var(--color-ln-azul)] underline"
              >
                {orgEmail}
              </a>
            </div>
          )}
          {jurisdictionLabel && (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3">
              <p className="text-xs uppercase tracking-wider text-[var(--color-ln-mute)]">Zona</p>
              <p className="text-base text-[var(--color-ln-ink)]">{jurisdictionLabel}</p>
            </div>
          )}
          {!orgPhone && !orgEmail && (
            <p className="text-xs text-[var(--color-ln-mute)]">
              {orgDisplayName} no tiene canales directos publicados. Mandá un mensaje desde el botón
              "Contactar al refugio" en la parte de arriba.
            </p>
          )}
        </div>
      </div>
    </Sheet>
  );
}
