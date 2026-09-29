// WalkInHistory — the pet's health record, read-only, ABOVE anything the vet
// can record (vet-visit-record, 2026-09-29).
//
// A vet should see what came before before writing what comes next: the last
// rabies dose, last month's weight, the intake of the previous atención. The
// data is getWalkInLibreta's org audience (libreta-sanitaria types only, no
// custody, no owner PII, no attachment URLs), and it renders only after
// resolveAtenderPet succeeded — the page withholds the history and the capture
// surface together when it does not.
//
// Read-only on purpose: no "Ver detalle" (the detail route is the holder's,
// and this clinic holds nothing), no "Pedir verificación" (an owner's action).
// Grouped by atención exactly like the libreta face (groupPastByVisit).

import { AsientoCard } from "@/components/pet-profile/AsientoCard";
import { toAsientoView } from "@/components/pet-profile/asiento-fields";
import { groupPastByVisit } from "@/components/pet-profile/libreta-visit-groups";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import type { WalkInLibreta } from "@/src/modules/pets/application/tab-data/get-walk-in-libreta";
import type { HistorialEventRow } from "@/src/modules/pets/application/tab-data/types";

export function WalkInHistory({
  history,
  publicToken,
  viewerUserId,
  now,
}: {
  /** Null when the read did not finish in its budget — said, never shown as empty. */
  history: WalkInLibreta | null;
  publicToken: string;
  viewerUserId: string;
  now: Date;
}) {
  if (history === null) {
    return (
      <OpCard>
        <OpCardHead title="Historia clínica" />
        <OpCardBody>
          <output className="block text-sm text-ln-op-mute">
            No pudimos cargar la historia clínica a tiempo. Recargá la página para verla antes de
            registrar.
          </output>
        </OpCardBody>
      </OpCard>
    );
  }
  // The walk-in reader is never the pet's titular: provenance must say who
  // wrote each record, never "Cargado por vos" on an owner's entry.
  const viewer = { userId: viewerUserId, currentOwnerUserId: null };
  const renderAsiento = (row: HistorialEventRow) => (
    <AsientoCard
      key={row.id}
      view={{ ...toAsientoView(row, publicToken, viewer, now), verifyHref: undefined }}
    />
  );

  return (
    <OpCard>
      <OpCardHead title="Historia clínica" />
      <OpCardBody>
        {history.past.length === 0 ? (
          <p className="text-sm text-ln-op-mute">
            Sin registros sanitarios todavía. Lo que registres hoy va a ser el primero.
          </p>
        ) : (
          <div className="ln-asientos max-h-[28rem] overflow-y-auto" data-section="walk-in-history">
            {groupPastByVisit(history.past, history.visits).map((entry) =>
              entry.kind === "event" ? (
                renderAsiento(entry.row)
              ) : (
                <section
                  key={`visit-${entry.visitId}`}
                  aria-label={entry.header}
                  className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-line p-2"
                >
                  <p className="px-1 text-xs font-semibold uppercase tracking-[.06em] text-ln-op-mute">
                    {entry.header}
                  </p>
                  {entry.rows.map(renderAsiento)}
                </section>
              ),
            )}
          </div>
        )}
        {history.truncated && (
          <p className="mt-3 text-xs text-ln-op-mute">Se muestran los registros más recientes.</p>
        )}
      </OpCardBody>
    </OpCard>
  );
}
