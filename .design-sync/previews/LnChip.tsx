// LnChip — selectable filter chip (LN skin).
import { LnChip } from "dim";

export function Tonos() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <LnChip tone="azul" selected>
        Perros
      </LnChip>
      <LnChip tone="azul">Gatos</LnChip>
      <LnChip tone="amber" selected>
        Vence pronto
      </LnChip>
      <LnChip tone="rojo" selected>
        Vencidas
      </LnChip>
      <LnChip>Todos</LnChip>
    </div>
  );
}
