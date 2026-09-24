// LnChipGroup — multi-select chip row driven by items/selected.
import { LnChipGroup } from "dim";

export function FiltroEspecies() {
  return (
    <LnChipGroup
      items={[
        { key: "dog", label: "Perros" },
        { key: "cat", label: "Gatos" },
        { key: "other", label: "Otras especies" },
        { key: "urgent", label: "Urgentes", tone: "rojo" },
      ]}
      selected={["dog", "urgent"]}
      onChange={() => {}}
    />
  );
}
