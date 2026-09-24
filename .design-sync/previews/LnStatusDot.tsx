// LnStatusDot — bare status indicator dot.
import { LnStatusDot } from "dim";

export function Tamanios() {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
      <LnStatusDot status="ok" size="sm" />
      <LnStatusDot status="ok" size="md" />
      <LnStatusDot status="sick" size="md" />
      <LnStatusDot status="lost" size="md" />
      <LnStatusDot status="pregnant" size="md" />
      <span style={{ fontSize: 12 }}>al día · en tratamiento · perdida · preñada</span>
    </div>
  );
}
