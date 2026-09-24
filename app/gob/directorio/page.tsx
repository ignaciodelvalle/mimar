// /gob/directorio — the Directorio hub.
//
// F3+F7 fusion (2026-07-22, PO-approved route unification: registry-entity
// management, identical roster grammar — same worker asking "¿esta entidad
// es legítima y está bien registrada?"): the hub ABSORBS Organizaciones,
// Usuarios, Servicios and RUPGA credentials as TABBED REGISTERS
// (`?registro=organizaciones|usuarios|servicios|credenciales`) of one screen.
//
// /gob/organizaciones, /gob/usuarios, /gob/servicios and /gob/rupga now
// permanently redirect here (query params preserved — see
// lib/ui/directorio-hub-redirect.ts). The admin portal has its OWN mirror at
// /admin/directorio (app/admin/directorio/page.tsx, a thin re-export of this
// same component — portal-follows-viewer: an admin viewer never bounces into
// gob chrome); /admin/organizaciones, /admin/usuarios and /admin/servicios
// redirect into THAT admin-scoped hub, not this one. RUPGA has no admin twin
// (unchanged).
//
// Default registro = "organizaciones" — the highest daily-traffic register
// (org verification/onboarding is the busiest gate; usuarios/servicios/
// credenciales are lower-frequency by comparison).
//
// The four register screens are IMPORTED, not rewritten — this is a
// relocation, not a redesign. Each keeps its own searchParams contract, its
// own auth guard, its own query logic, byte-identical to the former
// standalone pages (see OrganizacionesScreen / UsuariosScreen /
// ServiciosScreen / CredencialesScreen).

import { Suspense } from "react";

import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";

import { OrganizacionesScreen } from "@/app/gob/organizaciones/OrganizacionesScreen";
import { CredencialesScreen } from "@/app/gob/rupga/CredencialesScreen";
import { ServiciosScreen } from "@/app/gob/servicios/ServiciosScreen";
import { UsuariosScreen } from "@/app/gob/usuarios/UsuariosScreen";

export const dynamic = "force-dynamic";

type Registro = "organizaciones" | "usuarios" | "servicios" | "credenciales";
const DEFAULT_REGISTRO: Registro = "organizaciones";

function parseRegistro(raw: string | undefined): Registro {
  if (raw === "usuarios" || raw === "servicios" || raw === "credenciales") return raw;
  return DEFAULT_REGISTRO;
}

const REGISTRO_TABS: UrlTabItem[] = [
  { value: "organizaciones", label: "Organizaciones" },
  { value: "usuarios", label: "Usuarios" },
  { value: "servicios", label: "Servicios" },
  { value: "credenciales", label: "Credenciales" },
];

// A register-tab switch invalidates state that only makes sense under the
// PREVIOUS register — each register's "q" free-text search targets a
// DIFFERENT entity (org name vs person name vs credential/pet name), and
// verified/orgType/test/role/status are register-specific filter shapes
// (servicios' and credenciales' "status" enums don't even share a vocabulary:
// pending_approval/approved/rejected vs vigente/revocada/all). Unlike the
// Denuncias hub's etapa tabs (which share ONE WelfareReportKind/Severity
// vocabulary across both stages), nothing here carries over cleanly, so every
// register-specific param resets on switch.
const REGISTRO_RESET_PARAMS = ["q", "verified", "orgType", "test", "role", "status"] as const;

export default async function DirectorioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const registro = parseRegistro(sp.registro);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Directorio</p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          ¿Esta entidad es legítima y está bien registrada?
        </h1>
        {/* max-w-prose removed (hub-header wrap fix, validacion-A 2026-07-23):
            see app/gob/padron/page.tsx for the full rationale. */}
        <p className="text-md text-ln-op-ink-2">
          Organizaciones, usuarios, servicios y credenciales RUPGA comparten la misma gramática de
          registro: buscar, verificar y revocar. Elegí el registro en el que querés trabajar ahora.
        </p>
      </header>

      <Suspense>
        <UrlTabs
          paramKey="registro"
          defaultValue={DEFAULT_REGISTRO}
          tabs={REGISTRO_TABS}
          resetParamsOnChange={REGISTRO_RESET_PARAMS}
          aria-label="Registro del Directorio"
        >
          <UrlTabsContent value={registro}>
            {registro === "usuarios" ? (
              <UsuariosScreen searchParams={sp} underHub />
            ) : registro === "servicios" ? (
              <ServiciosScreen searchParams={sp} underHub />
            ) : registro === "credenciales" ? (
              <CredencialesScreen searchParams={sp} underHub />
            ) : (
              <OrganizacionesScreen searchParams={sp} underHub />
            )}
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>
    </div>
  );
}
