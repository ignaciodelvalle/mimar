// /admin/cuentas — the Cuentas privilegiadas hub.
//
// Privileged-accounts fusion (structural convergence 2026-08-02, mirroring
// the F3 Directorio hub shape): the hub ABSORBS /admin/govts and
// /admin/admins as TABBED REGISTERS (`?registro=govts|admins`) of one
// screen — the same admin doing the same job (who may operate this platform
// with privileges, and with what alcance) over two rosters that shared one
// grammar: search, alta, per-account drill, deactivate.
//
// UNLIKE Directorio's registers, the two panels stay DISTINCT screens under
// the tab shell — different tables and onboarding flows (govt_assignments
// jurisdiction alta/reasignación vs admin grant/revoke) — so this is a tab
// shell over two separate queries, never a merged one. Each panel keeps its
// own actions intact: govts (+ Crear gobierno, estado filter, dead-account
// remedy, /admin/govts/[userId] drill for localidades) and admins (+ Crear
// admin, system/deactivated partitions, /admin/admins/[userId] drill).
//
// /admin/govts and /admin/admins now permanently redirect here (query params
// preserved — see lib/ui/cuentas-hub-redirect.ts); their nested detail/form
// routes are UNCHANGED.
//
// Default registro = "govts" — the higher-traffic register (jurisdiction
// assignment churn vs the rare admin grant).
//
// The two register screens are IMPORTED, not rewritten — this is a
// relocation, not a redesign (F3/F6 hub precedent). Each keeps its own
// searchParams contract, its own auth guard (requireAdminOrRedirect — same
// guard both had standalone; the scoping does not change), its own query.

import { Suspense } from "react";

import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";

import { AdminsScreen } from "@/app/admin/admins/AdminsScreen";
import { GovtsScreen } from "@/app/admin/govts/GovtsScreen";

export const dynamic = "force-dynamic";

type Registro = "govts" | "admins";
const DEFAULT_REGISTRO: Registro = "govts";

function parseRegistro(raw: string | undefined): Registro {
  return raw === "admins" ? "admins" : DEFAULT_REGISTRO;
}

const REGISTRO_TABS: UrlTabItem[] = [
  { value: "govts", label: "Cuentas gobierno" },
  { value: "admins", label: "Administradores" },
];

// A register-tab switch invalidates state that only makes sense under the
// PREVIOUS register — each register's "q" free-text search targets a
// DIFFERENT roster, `status` only exists on govts, and the test-account
// toggle is a per-roster reveal. Same reasoning as the Directorio hub's
// full-reset (nothing carries over cleanly between registers).
const REGISTRO_RESET_PARAMS = ["q", "status", "test"] as const;

export default async function CuentasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const registro = parseRegistro(sp.registro);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          Cuentas privilegiadas
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          ¿Quién puede operar con privilegios, y con qué alcance?
        </h1>
        <p className="text-md text-ln-op-ink-2">
          Cuentas de gobierno y administradores comparten la misma gramática de roster — buscar, dar
          de alta, ajustar el alcance, desactivar — sobre dos registros distintos. Elegí el registro
          en el que querés trabajar ahora.
        </p>
      </header>

      <Suspense>
        <UrlTabs
          paramKey="registro"
          defaultValue={DEFAULT_REGISTRO}
          tabs={REGISTRO_TABS}
          resetParamsOnChange={REGISTRO_RESET_PARAMS}
          aria-label="Registro de Cuentas privilegiadas"
        >
          <UrlTabsContent value={registro}>
            {registro === "admins" ? (
              <AdminsScreen searchParams={sp} underHub />
            ) : (
              <GovtsScreen searchParams={sp} underHub />
            )}
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>
    </div>
  );
}
