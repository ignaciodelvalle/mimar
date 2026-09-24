// LnBadge — the LN-skin status pill (mono uppercase, tinted border).
// Real usage: compliance stamps and record annotations across the owner app.
import { LnBadge } from "dim";

export function Variantes() {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <LnBadge variant="success">Al día</LnBadge>
      <LnBadge variant="warning">Vence pronto</LnBadge>
      <LnBadge variant="danger">Vencida</LnBadge>
      <LnBadge variant="info">Verificada</LnBadge>
      <LnBadge variant="neutral">Sin datos</LnBadge>
    </div>
  );
}

export function EnContexto() {
  return (
    <div style={{ maxWidth: 420, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Vacuna antirrábica</span>
        <LnBadge variant="success">Al día</LnBadge>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Desparasitación</span>
        <LnBadge variant="warning">Vence en 9 días</LnBadge>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Microchip</span>
        <LnBadge variant="neutral">Declarado</LnBadge>
      </div>
    </div>
  );
}
