// OrganizacionesScreen — organization directory + revoke list.
//
// F3+F7 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/organizaciones (also /admin/organizaciones) page.tsx, relocated so the
// Directorio hub (app/gob/directorio/page.tsx, mirrored at
// app/admin/directorio/page.tsx) can render it as its "organizaciones"
// register under ?registro=organizaciones (the default). /gob/organizaciones
// and /admin/organizaciones now only redirect here via their portal's hub
// (see app/gob/organizaciones/page.tsx, app/admin/organizaciones/page.tsx) —
// this is a RELOCATION, not a redesign: same searchParams contract, same
// auth guard, same query logic. portalBase() still resolves correctly from
// the actual request pathname (middleware-stamped x-portal-base), regardless
// of which hub route renders this screen.

import Link from "next/link";

import { BulkRevokeList } from "@/components/BulkRevokeList";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { ResultCount } from "@/components/ui/ResultCount";
import {
  OpCard,
  OpCardBody,
  type OpFilterAxis,
  OpFilterBar,
  OpPill,
  SearchFilterField,
} from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import type { OrgTypeFilter, OrgVerifiedFilter } from "@/lib/infra/admin-search";
import { searchOrganizations } from "@/lib/infra/admin-search";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { panoramaScopeLabel } from "@/lib/panorama/scope-label";
import { portalBase } from "@/lib/ui/portal-base";
import { pluralizeEs } from "@/lib/utils/format";
import { logPiiReadSafely } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

import { ProposeOrgActions } from "./ProposeOrgActions";
import { RevokeOrgActions } from "./RevokeOrgActions";

const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: "Clínica",
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  sanitary_authority: "Autoridad sanitaria",
  other: "Otro",
};

const VERIFIED_FILTER_LABELS: Record<OrgVerifiedFilter, string> = {
  all: "Todas",
  verified: "Verificadas",
  pending: "Pendientes",
};

function parseVerifiedFilter(raw: string | undefined): OrgVerifiedFilter {
  return raw === "verified" || raw === "pending" ? raw : "all";
}

// ORG-TYPE filter select labels — "all" is the UI sentinel for "no filter".
const ORG_TYPE_FILTER_LABELS: Record<OrgTypeFilter, string> = {
  all: "Todos los tipos",
  clinic: "Clínica",
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  sanitary_authority: "Autoridad sanitaria",
  other: "Otro",
};

function parseOrgTypeFilter(raw: string | undefined): OrgTypeFilter {
  return raw === "clinic" ||
    raw === "shelter" ||
    raw === "rescue_network" ||
    raw === "sanitary_authority" ||
    raw === "other"
    ? raw
    : "all";
}

export type OrganizacionesScreenProps = {
  searchParams: { q?: string; verified?: string; orgType?: string };
  /**
   * True when rendered as the Directorio hub's "Organizaciones" tab
   * (app/gob/directorio/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function OrganizacionesScreen({
  searchParams: sp,
  underHub = false,
}: OrganizacionesScreenProps) {
  const query = (sp.q ?? "").trim();
  const verifiedFilter = parseVerifiedFilter(sp.verified);
  const orgTypeFilter = parseOrgTypeFilter(sp.orgType);
  const { user, profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const base = await portalBase();
  const { items: results, truncated } = await searchOrganizations(
    query,
    { role: profile.role, jurisdictions },
    verifiedFilter,
    orgTypeFilter,
  );

  // AC2: every PII read leaves a trail — both the typed-query search AND the
  // no-query landing. Awaited so the audit row is durable; the wrapper logs to
  // console.error and swallows on failure so it never breaks the render.
  await logPiiReadSafely(user.id, query, results.length, "organizations");

  return (
    <div className="space-y-6">
      <ScreenHeader
        underHub={underHub}
        eyebrow="miMAR Gobierno · Organizaciones"
        title="Organizaciones"
        subtitle={
          <p className="text-sm text-ln-op-ink-2">
            {profile.role === "admin"
              ? "Buscá por nombre, razón social o CUIT. Tu vista es universal."
              : // panoramaScopeLabel, not a raw count: "tus 1 localidad" is
                // broken grammar, and for a whole-province assignment (one
                // sentinel row) it also understated the real scope (9-role
                // external run, 2026-08-18).
                `Buscá entre las orgs de tu alcance: ${panoramaScopeLabel(profile.role, jurisdictions)}.`}
          </p>
        }
      />

      {/* Unified filter bar (opfilterbar-sweep2-2026-07-21 item 2) — migrated
          off the bespoke GET form. Verificación and Tipo are both genuinely
          "all shows everything" by default (no default-trap: the bespoke
          raw selects already defaulted to "all", same semantics as an
          OpFilterBar axis's own implicit blank "Todas" option), so both are
          registered axes. Free-text query is NOT an axis (no enumerable
          option set) — it renders via the shared SearchFilterField child,
          same pattern as /gob/usuarios and /admin/casos. No time dimension on
          a roster screen, so showPeriod={false}. Query param contract (q,
          verified, orgType) and scope/permission behavior are unchanged. */}
      <OpFilterBar
        showPeriod={false}
        axes={
          [
            {
              id: "verified",
              label: "Verificación",
              paramKey: "verified",
              options: (["verified", "pending"] as OrgVerifiedFilter[]).map((v) => ({
                value: v,
                label: VERIFIED_FILTER_LABELS[v],
              })),
              current: verifiedFilter === "all" ? null : verifiedFilter,
              allLabel: "Todas",
            },
            {
              id: "orgType",
              label: "Tipo",
              paramKey: "orgType",
              options: (Object.keys(ORG_TYPE_FILTER_LABELS) as OrgTypeFilter[])
                .filter((k) => k !== "all")
                .map((k) => ({ value: k, label: ORG_TYPE_FILTER_LABELS[k] })),
              current: orgTypeFilter === "all" ? null : orgTypeFilter,
              allLabel: "Todos los tipos",
            },
          ] satisfies OpFilterAxis[]
        }
      >
        <SearchFilterField
          paramKey="q"
          value={query}
          label="Buscar"
          placeholder="Buscar por nombre, razón social o CUIT"
        />
      </OpFilterBar>

      {/* Directorio hub sibling consistency (consistency sweep 2026-07-23):
          the empty-list case renders the shared LnEmptyState like the
          Servicios/Credenciales tabs, not a bare caption line. */}
      {results.length === 0 ? (
        <LnEmptyState
          title={
            query || verifiedFilter !== "all" || orgTypeFilter !== "all"
              ? "Sin resultados"
              : "Buscá organizaciones"
          }
          description={
            query || verifiedFilter !== "all" || orgTypeFilter !== "all"
              ? "Ajustá la búsqueda o los filtros."
              : "Ingresá nombre, razón social o CUIT para ver organizaciones."
          }
        />
      ) : (
        <ResultCount
          shown={results.length}
          // Truncated → the total is genuinely UNKNOWN (nobody counted past the
          // cap), so it must not be implied.
          total={truncated ? undefined : results.length}
          noun={pluralizeEs(results.length, "resultado")}
          hint="Usá el buscador para acotar la lista."
          className="text-sm text-ln-op-mute"
        />
      )}

      <BulkRevokeList
        items={results.map((o) => ({
          id: o.id,
          label: o.displayName,
          revocable: o.verified,
          content: (
            <OpCard>
              <OpCardBody>
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm font-medium text-ln-op-ink">{o.displayName}</p>
                      <p className="text-sm text-ln-op-mute">
                        {o.legalName} · {ORG_TYPE_LABELS[o.orgType] ?? o.orgType}
                        {o.cuit && ` · CUIT ${o.cuit}`}
                      </p>
                      <p className="text-xs text-ln-op-mute">
                        {o.jurisdictionLocality ?? "—"}, {o.jurisdictionProvince ?? "—"}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {o.verified ? (
                        <OpPill tone="ok">Verificada</OpPill>
                      ) : (
                        <OpPill tone="open">Pendiente</OpPill>
                      )}
                    </div>
                  </div>
                  <ProposeOrgActions org={o} />
                  {o.verified && (
                    <RevokeOrgActions
                      org={o}
                      actorUserId={user.id}
                      actorRole={profile.role}
                      jurisdictions={jurisdictions}
                    />
                  )}
                </div>
              </OpCardBody>
            </OpCard>
          ),
        }))}
        targetKind="org"
      />

      <p className="text-sm text-ln-op-mute">
        <Link href={base} className="underline underline-offset-4 hover:text-ln-op-ink-2">
          {"←"} Volver al panel
        </Link>
      </p>
    </div>
  );
}
