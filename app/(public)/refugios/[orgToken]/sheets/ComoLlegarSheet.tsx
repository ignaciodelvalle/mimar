"use client";

import { Sheet } from "@/components/ui/VaulSheet";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav } from "@/lib/ui/sheet-nav";
import { usePathname, useSearchParams } from "next/navigation";

// "Cómo llegar" — three navigator deep-links (handoff P2-9).
// Only renders when lat/lng are set; the LocationPanel only triggers
// this sheet when it has coordinates to show.

interface Props {
  orgDisplayName: string;
  latitude: number | null;
  longitude: number | null;
}

export function ComoLlegarSheet({ orgDisplayName, latitude, longitude }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const open = searchParams.get("sheet") === "como-llegar";

  const hasPoint = latitude != null && longitude != null;
  const coord = hasPoint ? `${latitude},${longitude}` : "";

  return (
    <Sheet
      id="como-llegar"
      title={`Cómo llegar a ${orgDisplayName}`}
      open={open}
      onClose={() => closeSheetNav(buildCloseSheetUrl(pathname, searchParams))}
      size="sm"
    >
      <div className="space-y-4">
        {hasPoint ? (
          <>
            <p className="text-sm text-[var(--color-ln-ink-2)]">
              Elegí la app que prefieras para abrir la ruta. Se abre en una pestaña nueva.
            </p>
            <div className="flex flex-col gap-2">
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${coord}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-3 text-center text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
              >
                Abrir en Google Maps
              </a>
              <a
                // https, not http. Apple redirects either way, but the first hop
                // of the plain one travels in clear carrying the destination
                // coordinates — and the destination here is a shelter someone is
                // on their way to.
                href={`https://maps.apple.com/?daddr=${coord}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-3 text-center text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
              >
                Abrir en Apple Maps
              </a>
              <a
                href={`https://waze.com/ul?ll=${coord}&navigate=yes`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-3 text-center text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
              >
                Abrir en Waze
              </a>
            </div>
          </>
        ) : (
          <p className="text-sm text-[var(--color-ln-mute)]">
            {orgDisplayName} no compartió su ubicación exacta. Contactalos para coordinar.
          </p>
        )}
      </div>
    </Sheet>
  );
}
