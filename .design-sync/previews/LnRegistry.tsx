// LnRegistry — container list for LnRegRow entries.
import { LnRegRow, LnRegistry } from "dim";

export function Listado() {
  return (
    <div style={{ maxWidth: 460 }}>
      <LnRegistry>
        <LnRegRow name="Firulais" status="ok" breed="Border collie" species="Perro" />
        <LnRegRow name="Michi" status="lost" breed="Común europeo" species="Gato" />
        <LnRegRow name="Rocco" status="ok" breed="Border collie" species="Perro" />
      </LnRegistry>
    </div>
  );
}
