// Showcase de primitivas de dashboards — Chunk E1.
// Ruta de QA visual para devs y diseño. Requiere autenticación; sin restricción de rol.
// No ejecuta queries reales — los datos son sintéticos para ilustrar cada componente.

import { Suspense } from "react";

import { MapChoroplethDynamic } from "@/components/charts/MapChoroplethDynamic";
import { TimeSeriesChartDynamic } from "@/components/charts/TimeSeriesChartDynamic";
import { JurisdictionSwitcher } from "@/components/gob/JurisdictionSwitcher";
import { PeriodPicker } from "@/components/gob/PeriodPicker";
import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { OpKpi } from "@/components/ui/dashboard";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Datos sintéticos
// ---------------------------------------------------------------------------

const SAMPLE_MAP_DATA = [
  { code: "AR-C", value: 420, label: "Ciudad Autónoma de Buenos Aires" },
  { code: "AR-B", value: 1240, label: "Buenos Aires" },
  { code: "AR-X", value: 680, label: "Córdoba" },
];

const SAMPLE_TIMESERIES = [
  { x: "Ene", y: 85 },
  { x: "Feb", y: 102 },
  { x: "Mar", y: 98 },
  { x: "Abr", y: 130 },
  { x: "May", y: 118 },
  { x: "Jun", y: 145 },
  { x: "Jul", y: 160 },
  { x: "Ago", y: 137 },
  { x: "Sep", y: 155 },
  { x: "Oct", y: 172 },
  { x: "Nov", y: 190 },
  { x: "Dic", y: 210 },
];

const SAMPLE_PROVINCES = [
  { code: "AR-C", name: "CABA" },
  { code: "AR-B", name: "Buenos Aires" },
  { code: "AR-X", name: "Córdoba" },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function DashboardPrimitivasPage() {
  await requireUserOrRedirect();

  return (
    <main className="min-h-screen bg-[var(--color-ln-stripe)] p-6">
      <div className="max-w-5xl mx-auto space-y-8 pt-4 pb-12">
        {/* Título */}
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-ln-ink)]">
            Primitivas de dashboards (E1)
          </h1>
          <p className="text-sm text-[var(--color-ln-mute)]">
            Showcase de QA visual para las 5 primitivas del Chunk E1. Datos sintéticos — reemplazar
            con datos reales en las rutas de dashboard (E2–E5).
          </p>
        </header>

        {/* ------------------------------------------------------------------ */}
        {/* 1. OpKpi — KPI tile (operator design system) */}
        {/* ------------------------------------------------------------------ */}
        <LnCard aria-labelledby="op-kpi-heading">
          <LnCardHead title={<span id="op-kpi-heading">OpKpi — KPI tile</span>} />
          <LnCardBody>
            <p className="text-xs text-[var(--color-ln-mute)] mb-4">
              Tres tonos: neutral / warn / danger. Con delta y sub opcionales.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <OpKpi
                label="Mascotas registradas"
                value="12,480"
                sub="mascotas · Actualizado hoy"
                tone="neutral"
              />
              <OpKpi
                label="Vacunas vencidas"
                value="348"
                delta={{ text: "+12% vs mes anterior", up: false }}
                sub="vacunas vencidas"
                tone="warn"
              />
              <OpKpi
                label="Denuncias abiertas"
                value="27"
                delta={{ text: "+5 esta semana", up: false }}
                sub="3 requieren intervención"
                tone="danger"
              />
            </div>
          </LnCardBody>
        </LnCard>

        {/* ------------------------------------------------------------------ */}
        {/* 2. MapChoropleth */}
        {/* ------------------------------------------------------------------ */}
        <LnCard aria-labelledby="map-choropleth-heading">
          <LnCardHead
            title={
              <span id="map-choropleth-heading">
                MapChoropleth — Mapa coroplético OSM / MapLibre
              </span>
            }
          />
          <LnCardBody>
            <p className="text-xs text-[var(--color-ln-mute)] mb-4">
              3 provincias de muestra (CABA, Buenos Aires, Córdoba). Tiles vía demotiles MapLibre
              (v1 placeholder — E-D1). GeoJSON en{" "}
              <code className="font-ln-mono text-xs bg-[var(--color-ln-stripe)] px-1 rounded">
                /geo/ar-provinces.geojson
              </code>
              .
            </p>
            {/* MapChoroplethDynamic already wraps next/dynamic({ ssr: false }) — no Suspense needed. */}
            <MapChoroplethDynamic
              data={SAMPLE_MAP_DATA}
              colorScale={["#bfdbfe", "#1e40af"]}
              height={400}
              fallbackTableLabel="Mascotas registradas por provincia"
            />
          </LnCardBody>
        </LnCard>

        {/* ------------------------------------------------------------------ */}
        {/* 3. TimeSeriesChart */}
        {/* ------------------------------------------------------------------ */}
        <LnCard aria-labelledby="timeseries-heading">
          <LnCardHead
            title={<span id="timeseries-heading">TimeSeriesChart — Serie temporal recharts</span>}
          />
          <LnCardBody>
            <p className="text-xs text-[var(--color-ln-mute)] mb-4">
              12 puntos mensuales sintéticos. Variante &ldquo;area&rdquo;. Animaciones respetan
              prefers-reduced-motion.
            </p>
            <TimeSeriesChartDynamic
              data={SAMPLE_TIMESERIES}
              seriesLabel="Denuncias registradas"
              yLabel="Denuncias"
              variant="area"
              strokeColor="#1e40af"
              height={300}
              fallbackTableLabel="Denuncias registradas por mes"
            />
          </LnCardBody>
        </LnCard>

        {/* ------------------------------------------------------------------ */}
        {/* 4. JurisdictionSwitcher */}
        {/* ------------------------------------------------------------------ */}
        <LnCard aria-labelledby="jurisdiction-heading">
          <LnCardHead
            title={
              <span id="jurisdiction-heading">
                JurisdictionSwitcher — Selector provincia → localidad
              </span>
            }
          />
          <LnCardBody>
            <p className="text-xs text-[var(--color-ln-mute)] mb-4">
              3 provincias de muestra. Seleccionar una provincia limpia la localidad. Cambios via
              router.replace preservando otros searchParams.
            </p>
            <Suspense fallback={null}>
              <JurisdictionSwitcher allowedProvinces={SAMPLE_PROVINCES} localities={[]} />
            </Suspense>
          </LnCardBody>
        </LnCard>

        {/* ------------------------------------------------------------------ */}
        {/* 5. PeriodPicker */}
        {/* ------------------------------------------------------------------ */}
        <LnCard aria-labelledby="period-picker-heading">
          <LnCardHead
            title={<span id="period-picker-heading">PeriodPicker — Selector de período</span>}
          />
          <LnCardBody>
            <p className="text-xs text-[var(--color-ln-mute)] mb-4">
              Chips de presets (7d / 30d / 90d / Año en curso) + rango personalizado vía
              DateRangePicker. Activo por defecto: 30d.
            </p>
            <Suspense fallback={null}>
              <PeriodPicker defaultPreset="30d" />
            </Suspense>
          </LnCardBody>
        </LnCard>
      </div>
    </main>
  );
}
