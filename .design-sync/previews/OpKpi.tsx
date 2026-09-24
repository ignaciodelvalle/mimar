// OpKpi — the operator-skin KPI tile (serif value, tone glyphs, optional
// delta/bar/sparkline). Real usage: /gob and /admin dashboard strips.
import { OpKpi, OpKpiSm } from "dim";

export function Tonos() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 220px)", gap: 12 }}>
      <OpKpi
        label="Cobertura antirrábica"
        value="72,4%"
        tone="ok"
        deltaV2={{ value: 3.2, period: "vs mes anterior" }}
      />
      <OpKpi
        label="Mordeduras (30d)"
        value="18"
        tone="warn"
        delta={{ text: "+4 vs mes anterior", up: true }}
      />
      <OpKpi label="Casos abiertos" value="7" tone="danger" sub="2 escalados" />
      <OpKpi label="Registros nuevos" value="1.204" tone="blue" bar={64} />
    </div>
  );
}

export function ConSparklineEInfo() {
  return (
    <div style={{ width: 260 }}>
      <OpKpi
        label="Esterilizaciones (12m)"
        value="4.310"
        tone="ok"
        sparkline={[210, 260, 245, 300, 380, 344, 402, 391, 455, 470, 431, 512]}
        info={{
          definition: "Esterilizaciones registradas en la jurisdicción en los últimos 12 meses.",
          formula: "count(sterilization_performed) / 12m",
          caveat: "Incluye solo eventos con procedencia profesional.",
        }}
      />
    </div>
  );
}

export function Compacto() {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <OpKpiSm label="Pendientes" value="12" tone="warn" sub="cola de registro" />
      <OpKpiSm label="Aprobados 7d" value="86" tone="ok" />
      <OpKpiSm label="Rechazados 7d" value="3" tone="neutral" />
    </div>
  );
}
