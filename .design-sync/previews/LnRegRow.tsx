// LnRegRow — pet registry row (photo + name + status + meta).
import { LnRegRow } from "dim";

export function Filas() {
  return (
    <div style={{ maxWidth: 460, display: "grid", gap: 4 }}>
      <LnRegRow
        name="Firulais"
        status="ok"
        breed="Border collie"
        species="Perro"
        nextLine="Antirrábica al día · próx. refuerzo jul 2027"
      />
      <LnRegRow
        name="Michi"
        status="lost"
        breed="Común europeo"
        species="Gato"
        nextLine="Perdida desde el 2 de julio — Recoleta"
      />
      <LnRegRow name="Atún" status="ok" breed="Siamés" species="Gato" nextLine="Vacuna en 9 días" />
    </div>
  );
}
