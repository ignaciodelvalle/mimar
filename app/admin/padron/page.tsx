// /admin/padron — the admin Padrón hub.
//
// F8 fusion (2026-07-22, PO-approved route unification): the admin-scoped
// mirror of the gob Padrón hub (Población/Censo tabs), but NOT a thin
// re-export like /admin/directorio — the admin Población/Censo bodies
// genuinely diverge from gob's (national ranked tables, forecast chart, no
// jurisdiction filter or choropleth), so this hub renders the admin-ONLY
// screens (AdminPoblacionScreen / AdminCensoScreen) under the same tab shape.
//
// /admin/poblacion and /admin/censo now permanently redirect here (query
// params preserved — see lib/ui/padron-hub-redirect.ts).
//
// Default vista = "poblacion" (matches the gob hub's default — see
// app/gob/padron/page.tsx for the rationale).
//
// The two vista screens are IMPORTED, not rewritten — this is a relocation,
// not a redesign. Each keeps its own searchParams contract, its own auth
// guard, its own query logic, byte-identical to the former standalone pages
// (see AdminPoblacionScreen / AdminCensoScreen).

import { Suspense } from "react";

import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";

import { AdminCensoScreen } from "@/app/admin/censo/AdminCensoScreen";
import { AdminPoblacionScreen } from "@/app/admin/poblacion/AdminPoblacionScreen";

export const dynamic = "force-dynamic";

type Vista = "poblacion" | "censo";
const DEFAULT_VISTA: Vista = "poblacion";

function parseVista(raw: string | undefined): Vista {
  return raw === "censo" ? "censo" : DEFAULT_VISTA;
}

const VISTA_TABS: UrlTabItem[] = [
  { value: "poblacion", label: "Población" },
  { value: "censo", label: "Censo" },
];

// Mirrors the gob hub: poblacion and censo share the exact same
// searchParams contract (period/from/to/species — admin has no jurisdiction
// filter), so a vista switch needs no reset.
const VISTA_RESET_PARAMS: readonly string[] = [];

export default async function AdminPadronPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const vista = parseVista(sp.vista);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          Admin · Padrón
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          ¿Crece sano el padrón y contenemos la población?
        </h1>
        {/* max-w-prose removed (hub-header wrap fix, validacion-A 2026-07-23):
            see app/gob/padron/page.tsx for the full rationale. */}
        <p className="text-md text-ln-op-ink-2">
          Vista nacional. Población (cobertura de esterilización vs. meta) y Censo (crecimiento y
          calidad del registro) leen el mismo padrón desde dos preguntas distintas.
        </p>
      </header>

      <Suspense>
        <UrlTabs
          paramKey="vista"
          defaultValue={DEFAULT_VISTA}
          tabs={VISTA_TABS}
          resetParamsOnChange={VISTA_RESET_PARAMS}
          aria-label="Vista del Padrón"
        >
          <UrlTabsContent value={vista}>
            {vista === "censo" ? (
              <AdminCensoScreen searchParams={sp} underHub />
            ) : (
              // Fix (adversarial-admin 2026-07-23, twin of gob C2): the hub's
              // own header already establishes identity for every vista, not
              // just censo — AdminPoblacionScreen now suppresses its own
              // eyebrow/h1 under the hub the same way.
              <AdminPoblacionScreen searchParams={sp} underHub />
            )}
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>
    </div>
  );
}
