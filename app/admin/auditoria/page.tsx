// /admin/auditoria — the Auditoría hub.
//
// Audit-trail fusion (structural convergence 2026-08-02): the hub ABSORBS
// /admin/historial as the "Actividad" vista (`?vista=sensibles|actividad`)
// of one screen. Both admin surfaces queried the SAME audit_log at the SAME
// universal admin scope — the historial page's own header said "parity with
// /admin/auditoria" — differing only in filter surface (period picker +
// mine-toggle vs. date-range + grouping/PII/target links). Same viewer, same
// data, two nav destinations: the tell that they were one screen.
//
// /admin/historial now permanently redirects here (query params preserved —
// see lib/ui/auditoria-hub-redirect.ts; the keyset cursor targets the same
// table and ordering, so it survives the hop).
//
// CRITICAL scope fence: /gob/historial is NOT part of this fusion — the govt
// twin is JURISDICTION-SCOPED ({ kind: "govt", actorIds }) and keeps its own
// standalone route, query and nav entry. Only the two universal-scope admin
// surfaces converge.
//
// Default vista = "sensibles" — the canonical route's own pre-fusion view
// (the global registro with grouping/PII masking/target links); "actividad"
// is the period-scoped activity audit ported from /admin/historial.
//
// The two vista screens are IMPORTED, not rewritten — this is a relocation,
// not a redesign (F6/F3 hub precedent). Each keeps its own searchParams
// contract, its own auth guard, its own query logic. The page keeps the
// pre-fusion streamed-shell contract (platform-budget T3.3): the default
// export is SYNCHRONOUS — the shell (loading skeleton) flushes before any
// DB call; AuditoriaScreen keeps the bounded 8 s fetch group.

import { Suspense } from "react";

import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";
import { OpDashboardSkeleton } from "@/components/ui/dashboard/OpDashboardSkeleton";

import { ActividadScreen } from "@/app/admin/historial/ActividadScreen";
import { AuditoriaScreen } from "./AuditoriaScreen";

export const dynamic = "force-dynamic";

type Vista = "sensibles" | "actividad";
const DEFAULT_VISTA: Vista = "sensibles";

function parseVista(raw: string | undefined): Vista {
  return raw === "actividad" ? "actividad" : DEFAULT_VISTA;
}

const VISTA_TABS: UrlTabItem[] = [
  { value: "sensibles", label: "Cambios sensibles" },
  { value: "actividad", label: "Actividad" },
];

// A vista switch invalidates only the keyset cursor's PAGE POSITION as a UX
// matter of course (page 1 of the other presentation), never its validity —
// both vistas read the same audit_log with the same (performed_at, id)
// ordering. `action`/`actor`/`from`/`to` are intentionally NOT reset: both
// vistas speak the exact same filter vocabulary over the same table, so an
// investigation's filters follow the operator across tabs (same reasoning as
// the Casos hub keeping `status`). `period` only drives the actividad vista
// and is ignored by sensibles — harmless to carry.
const VISTA_RESET_PARAMS = ["cursor"] as const;

type AuditoriaHubSearchParams = Promise<Record<string, string | undefined>>;

export default function AdminAuditoriaPage({
  searchParams,
}: {
  searchParams: AuditoriaHubSearchParams;
}) {
  // Sync export — skeleton config mirrors loading.tsx (T3.3 streamed shell).
  return (
    <Suspense fallback={<OpDashboardSkeleton cards={[10]} />}>
      <AuditoriaHubBody searchParams={searchParams} />
    </Suspense>
  );
}

async function AuditoriaHubBody({ searchParams }: { searchParams: AuditoriaHubSearchParams }) {
  const sp = await searchParams;
  const vista = parseVista(sp.vista);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Auditoría</p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          ¿Quién hizo qué, y necesito investigarlo?
        </h1>
        <p className="text-md text-ln-op-ink-2">
          Un solo registro de auditoría, dos lecturas: los cambios sensibles que requieren
          investigación y la actividad de los operadores por período. Elegí la vista que necesitás
          ahora.
        </p>
      </header>

      <UrlTabs
        paramKey="vista"
        defaultValue={DEFAULT_VISTA}
        tabs={VISTA_TABS}
        resetParamsOnChange={VISTA_RESET_PARAMS}
        aria-label="Vista de Auditoría"
      >
        <UrlTabsContent value={vista}>
          {vista === "actividad" ? (
            <ActividadScreen searchParams={sp} underHub />
          ) : (
            <AuditoriaScreen searchParams={sp} underHub />
          )}
        </UrlTabsContent>
      </UrlTabs>
    </div>
  );
}
