// /admin/acerca/integracion-miarg — Mi Argentina illustrative close view.
//
// Illustrative-only page for the demo close beat. Shows Mi Argentina styling
// with a non-hideable disclaimer ("Integración en desarrollo — vista ilustrativa").
//
// No OIDC is wired here. app/auth/miarg/callback/route.ts stays a gated stub.
// This page is only reachable by authenticated admins (protected by the
// app/admin/layout.tsx guard: requireAdminOrRedirect).

import type { Metadata } from "next";

import { OpButton } from "@/components/ui/dashboard";

export const metadata: Metadata = {
  title: "Integración Mi Argentina — miMAR",
};

export default function IntegracionMiArgPage() {
  return (
    <div className="mx-auto max-w-xl space-y-8 px-4 py-12">
      {/* Non-hideable disclaimer — always visible (D3 requirement). */}
      <output
        aria-label="Aviso de vista ilustrativa"
        data-testid="miarg-disclaimer"
        className="block rounded-[var(--radius-lg)] border-2 border-ln-op-warn-bd bg-ln-op-warn-bg px-5 py-3 text-center text-md font-semibold text-ln-op-ink"
      >
        Integración en desarrollo — vista ilustrativa
      </output>

      {/* Mi Argentina card — illustrative styling only. */}
      <div className="overflow-hidden rounded-[12px] border border-ln-op-line bg-ln-op-card shadow-sm">
        {/* Header strip — Mi Argentina blue palette (illustrative). */}
        <div className="flex items-center gap-3 bg-ln-op-navy px-6 py-4">
          {/* Coat-of-arms placeholder */}
          <div
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-ln-op-navy text-sm font-bold tracking-wide select-none"
          >
            AR
          </div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-white/70">
              República Argentina
            </p>
            <p className="text-base font-bold text-white">Mi Argentina</p>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-5 px-6 py-6">
          <div className="space-y-1">
            <p className="text-sm font-semibold uppercase tracking-wide text-ln-op-mute">
              Ciudadano verificado
            </p>
            <p className="text-lg font-semibold text-ln-op-ink">Carlos Ramírez Moreno</p>
            <p className="text-sm text-ln-op-ink-2">DNI 30.485.211</p>
          </div>

          <div className="rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-stripe px-4 py-3 space-y-1">
            <p className="text-sm font-semibold uppercase tracking-wide text-ln-op-mute">
              Mascotas registradas en miMAR
            </p>
            <ul className="space-y-0.5 text-md text-ln-op-ink">
              <li>• Duque — Labrador Retriever — Microchip 858000011223</li>
              <li>• Mimi — Angora — sin microchip</li>
            </ul>
          </div>

          <div className="rounded-[var(--radius-lg)] border border-ln-op-line bg-ln-op-stripe px-4 py-3 space-y-1">
            <p className="text-sm font-semibold uppercase tracking-wide text-ln-op-mute">
              Acciones disponibles
            </p>
            <ul className="space-y-0.5 text-sm text-ln-op-ink-2">
              <li>• Ver historial sanitario</li>
              <li>• Descargar constancia de vacunación antirrábica</li>
              <li>• Reportar mascota perdida</li>
            </ul>
          </div>

          {/* CTA — illustrative, no action. */}
          <OpButton type="button" disabled aria-disabled="true" variant="primary" block>
            Acceder con Mi Argentina (próximamente)
          </OpButton>
        </div>
      </div>

      {/* Footer note */}
      <p className="text-center text-sm text-ln-op-mute">
        La autenticación con Mi Argentina (OIDC) está en desarrollo. Esta pantalla es una maqueta
        ilustrativa para el proceso de demo.
      </p>
    </div>
  );
}
