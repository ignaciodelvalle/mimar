// /gob/programa — the Programa hub.
//
// F9 fusion (2026-08-01, PO decision on an external-QA navigation gate): the
// hub ABSORBS Analítica as TABBED VISTAS (`?vista=resumen|analitica`) of one
// screen.
//
// THE DEFECT THIS CLOSES. Two nav destinations shared one noun. The briefing
// alerts on /gob rendered "Ver en Programa →" and landed on /gob/programa;
// four KPI tiles in the same jurisdiction panel landed on /gob/analytics,
// whose h1 read "Analítica". Both were "the numbers screen", both were reached
// from the same panel, and they were not the same screen. A funcionario who
// follows two paths that sound alike and arrives somewhere different stops
// trusting the nav — and the nav is the part of a demo nobody re-reads.
//
// /gob/analytics now permanently redirects here (query params preserved — see
// lib/ui/programa-hub-redirect.ts), as does the /gob/analitica typo alias
// (directly, not via /gob/analytics: no visitor pays for two hops). Neither
// has a nav entry anymore. /gob/analytics/export is UNCHANGED — a child form
// route with its own searchParams contract, not a view of the dashboard.
//
// Default vista = "resumen" — the accountable outcome-vs-target read
// (registro, esterilización, microchip, SLA, provincias bajo meta) that
// leadership tracks and that every alert deep-links into. Analítica is the
// depth behind those numbers (adquisición por método, señales por mes, acceso
// veterinario, causas de muerte, brotes históricos), read on demand.
//
// CONTENT RULE (PO, F9): a figure that already appears in Resumen is LINKED
// from Analítica, never restated there. Two tabs that publish the same number
// twice reintroduce the exact ambiguity this fusion removed.
//
// The two vista screens are IMPORTED, not rewritten — this is a relocation,
// not a redesign. Each keeps its own searchParams contract, its own auth
// guard, its own query logic (see ProgramaResumenScreen / AnalyticsScreen).
//
// The admin portal is deliberately NOT part of this fusion: /admin/programa
// and /admin/inteligencia stay as they are. Whether "Analítica" and
// "Inteligencia" should share one vocabulary is an OPEN QUESTION for the PO,
// explicitly out of F9's scope.

import { Suspense } from "react";

import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";

import { AnalyticsScreen } from "@/app/gob/analytics/AnalyticsScreen";
import { ProgramaResumenScreen } from "@/app/gob/programa/ProgramaResumenScreen";

export const dynamic = "force-dynamic";

type Vista = "resumen" | "analitica";
const DEFAULT_VISTA: Vista = "resumen";

function parseVista(raw: string | undefined): Vista {
  return raw === "analitica" ? "analitica" : DEFAULT_VISTA;
}

const VISTA_TABS: UrlTabItem[] = [
  { value: "resumen", label: "Resumen" },
  { value: "analitica", label: "Analítica" },
];

// A vista switch does NOT need to reset anything: resumen and analitica share
// the EXACT same searchParams contract (period/from/to/province/locality) —
// both resolve their scope through resolveJurisdictionScope and their window
// through the same period resolver, so staying on e.g. a selected province
// while switching vistas is the point of the fusion, not a bug (unlike
// Casos/Disputas, which diverge on kind/province/cursor).
const VISTA_RESET_PARAMS: readonly string[] = [];

export default async function GobProgramaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const vista = parseVista(sp.vista);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Programa</p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          ¿Estamos cumpliendo el programa en tu jurisdicción?
        </h1>
        <p className="text-md text-ln-op-ink-2">
          Resumen (cobertura vs. meta, calidad de datos y cola) y Analítica (la profundidad detrás
          de esos números) leen el mismo programa desde dos preguntas distintas. Elegí la vista en
          la que querés trabajar ahora.
        </p>
      </header>

      <Suspense>
        <UrlTabs
          paramKey="vista"
          defaultValue={DEFAULT_VISTA}
          tabs={VISTA_TABS}
          resetParamsOnChange={VISTA_RESET_PARAMS}
          aria-label="Vista del Programa"
        >
          <UrlTabsContent value={vista}>
            {vista === "analitica" ? (
              <AnalyticsScreen searchParams={sp} underHub />
            ) : (
              <ProgramaResumenScreen searchParams={sp} underHub />
            )}
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>
    </div>
  );
}
