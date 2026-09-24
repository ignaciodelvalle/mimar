// OpKpiSm — compact KPI tile (operator skin).
import { OpKpiSm } from "dim";

export function Fila() {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <OpKpiSm label="Pendientes" value="12" tone="warn" sub="cola de registro" />
      <OpKpiSm label="Aprobados 7d" value="86" tone="ok" />
      <OpKpiSm label="Rechazados 7d" value="3" tone="neutral" />
      <OpKpiSm label="Escalados" value="2" tone="danger" />
    </div>
  );
}
