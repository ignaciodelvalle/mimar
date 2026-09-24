// LnInput — text input (LN skin); pairs with LnField for label/error wiring.
import { LnInput } from "dim";

export function Estados() {
  return (
    <div style={{ maxWidth: 340, display: "grid", gap: 12 }}>
      <LnInput placeholder="Nombre de la mascota" />
      <LnInput defaultValue="858000100000054" mono />
      <LnInput defaultValue="8580001" invalid />
    </div>
  );
}
