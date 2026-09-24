// LnPetPill — pet selector pill (capture bar / pickers).
import { LnPetPill } from "dim";

export function Seleccion() {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <LnPetPill name="Firulais" status="ok" active />
      <LnPetPill name="Michi" status="lost" />
      <LnPetPill name="Atún" status="ok" />
      <LnPetPill name="Luna" status="pregnant" />
    </div>
  );
}
