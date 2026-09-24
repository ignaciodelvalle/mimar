// LnVstamp — vaccination validity stamp (ok / due / over).
import { LnVstamp } from "dim";

export function Variantes() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <LnVstamp variant="ok" />
      <LnVstamp variant="due" />
      <LnVstamp variant="over" />
    </div>
  );
}

export function EnFila() {
  return (
    <div style={{ maxWidth: 380, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Antirrábica 2026</span>
        <LnVstamp variant="ok" />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Séxtuple refuerzo</span>
        <LnVstamp variant="due" />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>Triple felina 2025</span>
        <LnVstamp variant="over" />
      </div>
    </div>
  );
}
