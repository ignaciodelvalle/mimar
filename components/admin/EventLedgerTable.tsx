// EventLedgerTable — presentational table for /admin/libro (WS-L).
//
// Renders the append-only event stream (beat 1) as an accessible data table.
// Each data row is the client EventLedgerRow (beat 2: expandable amendment
// chain; beat 3: temporal-replay deep-link).
//
// A11y (Wave 2 Item 11): <caption> describes the table; every <th> has
// scope="col". The expandable affordance + focus management live in the row.

import { EventLedgerRow } from "@/app/admin/libro/EventLedgerRow";
import type { LedgerRowView } from "@/app/admin/libro/view";

type Props = {
  rows: LedgerRowView[];
};

export function EventLedgerTable({ rows }: Props) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-md text-ln-op-ink">
        <caption className="sr-only">
          Libro de eventos: registro append-only de eventos del sistema. Cada fila muestra el tipo,
          el actor, la jurisdicción, cuándo ocurrió y cuándo se registró. Las filas corregidas por
          enmienda se pueden expandir para ver la cadena de correcciones; el original se conserva.
        </caption>
        <thead>
          <tr className="border-b border-ln-op-line">
            <th scope="col" className="py-2 pr-4 text-left font-semibold text-ln-op-mute">
              Evento
            </th>
            <th scope="col" className="py-2 pr-4 text-left font-semibold text-ln-op-mute">
              Actor
            </th>
            <th scope="col" className="py-2 pr-4 text-left font-semibold text-ln-op-mute">
              Jurisdicción
            </th>
            <th scope="col" className="py-2 pr-4 text-left font-semibold text-ln-op-mute">
              Fechas
            </th>
            <th scope="col" className="py-2 text-right font-semibold text-ln-op-mute">
              Reproducción
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <EventLedgerRow key={row.id} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
