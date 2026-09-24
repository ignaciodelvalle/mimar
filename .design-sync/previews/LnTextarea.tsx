// LnTextarea — multiline input (LN skin).
import { LnTextarea } from "dim";

export function Estados() {
  return (
    <div style={{ maxWidth: 420, display: "grid", gap: 12 }}>
      <LnTextarea rows={3} placeholder="Contanos qué pasó…" />
      <LnTextarea rows={2} defaultValue="Texto demasiado corto" invalid />
    </div>
  );
}
