/**
 * loading.tsx — skeleton for /gob/usuarios (govt user list with PII queries).
 */

import { OpCardSkeleton } from "@/components/ui/dashboard/OpCardSkeleton";

export default function GobUsuariosLoading() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="op-fade-in mx-auto max-w-5xl px-8 py-7 pb-12 block"
    >
      <span className="sr-only">Cargando…</span>
      <OpCardSkeleton rows={8} />
    </output>
  );
}
