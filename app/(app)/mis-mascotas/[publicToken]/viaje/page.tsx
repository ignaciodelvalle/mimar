// /mis-mascotas/[publicToken]/viaje — cross-border travel registry
// (movilidad Fase 1, Capability 4).
//
// UX HONESTY PASS (PO decision, 2026-07-19): this feature is dead
// end-to-end. No server action anywhere writes a transport_recorded event —
// recordMoveAction (src/modules/pets/actions.ts) only ever emits
// jurisdiction_changed (domestic moves via /mudanza); TransportRecordedMovement
// (src/modules/pets/application/movement/types.ts) is declared but has no
// writer, no form, no entry point. The compliance-copilot UI that used to
// render here (TravelSemaforo/TravelObligationsPanel/TravelExportButton) was
// therefore a facade: it could only ever show data derived from domestic
// jurisdiction moves, never real cross-border travel. Rather than hide the
// route (404) or keep pretending it's live, this page now shows an honest
// "Próximamente" placeholder. Entry points are greyed out with the same
// message — see MasSheet.helpers.ts's "travel" item (ADR-17c idiom, same
// capability-gating spirit as MpfExportGate).
//
// Nothing below was deleted: the event schema (movement_recorded / event-
// schemas.ts), the writer (record-movement.ts), the projection
// (lib/projections/travel-compliance.ts), the corridor reference data, and
// the three component files above are all untouched and ready to be wired
// back in once an actual transport_recorded writer ships.
//
// Owner-path ONLY in Fase 1 (R4.2, mirrors generatePppExport's ownership
// stance): the org-mediated path is rejected even though requirePetAccess
// supports it.

import Link from "next/link";
import { notFound } from "next/navigation";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { requireOwnedPetByToken } from "@/lib/infra/pets";

export default async function ViajePage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const access = await requireOwnedPetByToken(publicToken);
  if (access.accessPath !== "owner") notFound(); // R4.2 — owner-only in Fase 1
  const { pet } = access;

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-lg font-semibold">Viaje y movilidad</h1>
      <LnEmptyState
        variant="dashed"
        title="Próximamente"
        description={`El registro de viajes al exterior con ${pet.name} todavía no está disponible. Estamos trabajando para que puedas ver acá los requisitos del corredor y el semáforo de cumplimiento antes de viajar.`}
        action={
          <Link href={`/mis-mascotas/${pet.publicToken}`} className="underline text-sm">
            Volver a la credencial
          </Link>
        }
      />
    </main>
  );
}
