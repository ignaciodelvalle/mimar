// PhysicalTagDemandCard — where owners are asking for a physical tag.
//
// WHY THIS EXISTS (audit 2026-08-04). The "¿Querés una chapa física?" sheet on
// a pet's profile told the owner "te avisamos cuando estén disponibles" and
// wrote a `physical_tag_interest` row. Nothing could read that row as a list:
// the single reader was `getPhysicalTagInterest(petId, userId)`, which answers
// "did YOU already ask?" and nothing else. So the promise had no mechanism
// behind it — the same defect as the shelter contact form whose messages had no
// inbox, found and fixed the same day.
//
// Aggregated by locality and NOT listed per person, on purpose. The decision
// this feeds is the manufacturer / distribution call that blocks the physical
// tag entirely (A1, decisions D4 and D5 of the spec), and that call is made per
// municipality. Names would be PII on a screen that does not need them to
// answer its question. When a channel actually opens somewhere, the per-locality
// row is the query you extend to reach those owners.

import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { getPhysicalTagDemand } from "@/lib/infra/physical-tag-interest";
import { formatDateShort, pluralizeEs } from "@/lib/utils/format";

export async function PhysicalTagDemandCard() {
  const { rows, totalPets, totalOwners } = await getPhysicalTagDemand();

  return (
    <OpCard>
      <OpCardHead title="Interés en chapa física" />
      <OpCardBody>
        {totalPets === 0 ? (
          <p className="text-sm text-ln-op-mute">
            Todavía nadie pidió una chapa física. Cuando alguien toque «Me interesa» en el perfil de
            su mascota, va a aparecer acá agrupado por localidad.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ln-op-ink-2">
              <strong className="font-semibold text-ln-op-ink">
                {totalOwners} {pluralizeEs(totalOwners, "persona")}
              </strong>{" "}
              {pluralizeEs(totalOwners, "anotada")} por {totalPets}{" "}
              {pluralizeEs(totalPets, "mascota")}. Hoy el aviso a esas personas es manual y sale de
              esta lista.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Interés activo en chapa física, por jurisdicción de la mascota
                </caption>
                <thead>
                  <tr className="border-b border-ln-op-line text-left">
                    <th scope="col" className="py-1.5 pr-3 font-medium text-ln-op-mute">
                      Localidad
                    </th>
                    <th scope="col" className="py-1.5 pr-3 font-medium text-ln-op-mute">
                      Provincia
                    </th>
                    <th
                      scope="col"
                      className="py-1.5 pr-3 text-right font-medium text-ln-op-mute tabular-nums"
                    >
                      Personas
                    </th>
                    <th
                      scope="col"
                      className="py-1.5 pr-3 text-right font-medium text-ln-op-mute tabular-nums"
                    >
                      Mascotas
                    </th>
                    <th scope="col" className="py-1.5 font-medium text-ln-op-mute">
                      Primer pedido
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={`${r.province ?? "—"}|${r.locality ?? "—"}`}
                      className="border-b border-ln-op-line-2 last:border-0"
                    >
                      <td className="py-1.5 pr-3 text-ln-op-ink">
                        {r.locality ?? "Sin localidad"}
                      </td>
                      <td className="py-1.5 pr-3 text-ln-op-ink-2">{r.province ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-right text-ln-op-ink tabular-nums">
                        {r.owners}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-ln-op-ink-2 tabular-nums">
                        {r.pets}
                      </td>
                      <td className="py-1.5 text-ln-op-mute">
                        {r.firstRequestedAt ? formatDateShort(r.firstRequestedAt) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* States what the numbers do NOT cover, in the same breath as the
                numbers — the counts are of ACTIVE interest, so a cancellation
                removes a person silently and the total can go down. */}
            <p className="text-xs text-ln-op-mute">
              Cuenta el interés activo: si alguien cancela, deja de figurar. «Personas» cuenta
              titulares distintos — uno con cuatro mascotas es un cliente, no cuatro.
            </p>
          </div>
        )}
      </OpCardBody>
    </OpCard>
  );
}
