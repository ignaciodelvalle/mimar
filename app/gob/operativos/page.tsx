// /gob/operativos — the Operativos hub.
//
// F2 fusion (2026-07-22, PO-approved route unification: same worker, same
// weekly planning moment — the field coordinator asking "¿dónde y cómo
// intervengo esta semana?"): the hub ABSORBS Campañas and Alcance comunitario
// as TABBED VIEWS of one screen (`?vista=campanas|alcance`).
//
// /gob/campanas and /gob/outreach now permanently redirect here (query params
// preserved — see lib/ui/operativos-hub-redirect.ts); neither had nested
// detail routes besides their own /export CSV downloads, which are UNCHANGED.
//
// Default vista = "alcance", not "campanas": alcance comunitario is the
// ACTION PIPELINE (each pipeline converts a KPI into a target list an
// operator acts on THIS week — antirrábica vencida, densidad de escaneos,
// ranking de esterilización), while campañas is the CONVERSION READOUT (how
// did already-launched campaigns perform). Same "action beats analytics"
// precedent the Denuncias hub set (F1, defaulting to triage over moderación):
// the operator's default "what do I work on right now" answer is the
// pipeline, not the retrospective.
//
// The two view screens are IMPORTED, not rewritten — this is a relocation,
// not a redesign. Each keeps its own searchParams contract (alcance takes
// none), its own auth guard, its own query logic, byte-identical to the
// former standalone pages (see CampanasScreen / AlcanceScreen).

import { Suspense } from "react";

import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";

import { CampanasScreen } from "@/app/gob/campanas/CampanasScreen";
import { AlcanceScreen } from "@/app/gob/outreach/AlcanceScreen";

export const dynamic = "force-dynamic";

type Vista = "campanas" | "alcance";
const DEFAULT_VISTA: Vista = "alcance";

function parseVista(raw: string | undefined): Vista {
  return raw === "campanas" ? "campanas" : DEFAULT_VISTA;
}

const VISTA_TABS: UrlTabItem[] = [
  { value: "alcance", label: "Alcance comunitario" },
  { value: "campanas", label: "Campañas" },
];

export default async function GobOperativosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const vista = parseVista(sp.vista);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Operativos</p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          ¿Dónde y cómo intervengo esta semana?
        </h1>
        {/* max-w-prose removed (hub-header wrap fix, validacion-A 2026-07-23):
            see app/gob/padron/page.tsx for the full rationale. */}
        <p className="text-md text-ln-op-ink-2">
          Alcance comunitario convierte un indicador en una lista objetivo para actuar ahora;
          Campañas muestra cómo están rindiendo los operativos ya lanzados.
        </p>
      </header>

      <Suspense>
        <UrlTabs
          paramKey="vista"
          defaultValue={DEFAULT_VISTA}
          tabs={VISTA_TABS}
          aria-label="Vista de operativos"
        >
          <UrlTabsContent value={vista}>
            {vista === "campanas" ? (
              <CampanasScreen searchParams={sp} underHub />
            ) : (
              <AlcanceScreen underHub searchParams={sp} />
            )}
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>
    </div>
  );
}
