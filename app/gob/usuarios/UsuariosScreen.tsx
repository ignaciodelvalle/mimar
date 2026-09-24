// UsuariosScreen — govt/admin user roster with PII-audited search.
//
// F3+F7 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/usuarios (also /admin/usuarios) page.tsx, relocated so the Directorio
// hub (app/gob/directorio/page.tsx, mirrored at app/admin/directorio/page.tsx)
// can render it as its "usuarios" register under ?registro=usuarios.
// /gob/usuarios and /admin/usuarios now only redirect here via their
// portal's hub (see app/gob/usuarios/page.tsx, app/admin/usuarios/page.tsx)
// — this is a RELOCATION, not a redesign: same searchParams contract, same
// auth guard, same query logic. portalBase() still resolves correctly from
// the actual request pathname (middleware-stamped x-portal-base), regardless
// of which hub route renders this screen.

import Link from "next/link";

import { BulkRevokeList } from "@/components/BulkRevokeList";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { ResultCount } from "@/components/ui/ResultCount";
import {
  OpBreach,
  OpCard,
  OpCardBody,
  type OpFilterAxis,
  OpFilterBar,
  OpPill,
  SearchFilterField,
} from "@/components/ui/dashboard";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { fetchChipReplacementSignal } from "@/lib/analytics/compliance-metrics";
import { roleLabel } from "@/lib/domain/role-labels";
import type { UserRoleFilter } from "@/lib/infra/admin-search";
import { searchUsers } from "@/lib/infra/admin-search";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { isTestAccount } from "@/lib/infra/test-accounts";
import { buildProjectionContext } from "@/lib/metrics";
import { windows } from "@/lib/metrics/period";
import { buildAuthEmailMap, createAdminClient } from "@/lib/supabase/admin";
import { deriveTargetHref } from "@/lib/ui/audit-target-link";
import { portalBase } from "@/lib/ui/portal-base";
import { pluralizeEs } from "@/lib/utils/format";
import { logPiiReadSafely } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

import { ProposeUserActions } from "./ProposeUserActions";
import { RevokeUserActions } from "./RevokeUserActions";

// The role label is NOT a local map any more. This screen kept its own copy of
// the four labels, `Record<string, …>` rather than keyed on the role union, and
// when migration 0214 added `national` the copy silently rendered the raw enum
// value "national" in the roster pill. `roleLabel` is the one place that owns
// this wording; a second copy is a second thing to forget.
type RoleTone = "neutral" | "ok" | "triaged" | "open";
// KEYED ON THE ROLE UNION so the next role added to the enum fails the build
// here instead of falling through to "neutral".
const ROLE_TONES: Record<Exclude<UserRoleFilter, "all">, RoleTone> = {
  owner: "neutral",
  vet: "ok",
  govt: "triaged",
  national: "triaged",
  admin: "open",
};

// ROLE filter select labels — "all" is the UI sentinel for "no filter".
const ROLE_FILTER_LABELS: Record<UserRoleFilter, string> = {
  all: "Todos",
  owner: "Dueño/a",
  vet: "Veterinario/a",
  govt: "Gobierno",
  national: "Lectura nacional",
  admin: "Administrador/a",
};

// The options the Rol dropdown offers, DERIVED from the label map above.
//
// This was a hand-written `["owner", "vet", "govt", "admin"] as UserRoleFilter[]`
// and the cast is what made it dangerous: an incomplete array widened to the
// union compiles happily, so when migration 0214 added `national` the label map
// grew (the compiler insisted) and the dropdown did not. The roster could name
// the new role and not offer it — half a fix, in the same file as the fix.
//
// A cast defeats the compiler exactly like a hand-written union does. Reading
// the keys off the record keeps the control and the labels in step by
// construction, with no list to forget.
const ROLE_FILTER_OPTIONS = (Object.keys(ROLE_FILTER_LABELS) as UserRoleFilter[]).filter(
  (role): role is Exclude<UserRoleFilter, "all"> => role !== "all",
);

function parseRoleFilter(raw: string | undefined): UserRoleFilter {
  // Read off the label map rather than a second list of literals — the two
  // drifted apart once already, and the map is the one the compiler checks.
  return raw !== undefined && raw !== "all" && raw in ROLE_FILTER_LABELS
    ? (raw as UserRoleFilter)
    : "all";
}

export type UsuariosScreenProps = {
  searchParams: { q?: string; test?: string; role?: string };
  /**
   * True when rendered as the Directorio hub's "Usuarios" tab
   * (app/gob/directorio/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function UsuariosScreen({ searchParams: sp, underHub = false }: UsuariosScreenProps) {
  const query = (sp.q ?? "").trim();
  const showTestAccounts = sp.test === "1";
  const roleFilter = parseRoleFilter(sp.role);
  const { user, profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const base = await portalBase();
  const allResults = await searchUsers(query, { role: profile.role, jurisdictions }, roleFilter);

  // I1: emails live in auth.users (no email column on profiles) — resolve them so
  // each row shows a human email + estado instead of an opaque UUID. Same
  // service-role map the /admin/govts roster uses; the PII read is audited below.
  const supabase = createAdminClient();
  const emailMap = await buildAuthEmailMap(supabase);

  // I3: default ephemeral genesis/smoke accounts OUT of the roster so real users
  // aren't buried under `uc-cd-*` / `*-gen-*` rows. UI-level only (production has
  // none); the toggle reveals them. Match on both display name and resolved email.
  const hiddenTestCount = showTestAccounts
    ? 0
    : allResults.filter((u) => isTestAccount(u.displayName, emailMap.get(u.id))).length;
  const results = showTestAccounts
    ? allResults
    : allResults.filter((u) => !isTestAccount(u.displayName, emailMap.get(u.id)));

  // Toggle for the test-account filter — preserves the active query + role
  // filter. F3+F7 fusion (2026-07-22): points at the Directorio hub's
  // "usuarios" register, not the old (now-redirecting) standalone route.
  const testToggleHref = (() => {
    const params = new URLSearchParams();
    params.set("registro", "usuarios");
    if (query) params.set("q", query);
    if (roleFilter !== "all") params.set("role", roleFilter);
    if (!showTestAccounts) params.set("test", "1");
    return `${base}/directorio?${params.toString()}`;
  })();

  // Registro & cumplimiento (Item 4): C5 chip-fraud signal (microchip_replaced
  // flagged fraud/duplicate, last 12m) — surfaces replacements for HUMAN
  // REVIEW only, it does not auto-classify. (The C2 ISO-validity KPI that used
  // to sit alongside this was removed from this screen —
  // opfilterbar-sweep2-2026-07-21 item 1: it's a chip/pet ISO-compliance
  // metric, not a users-roster metric — it had nowhere to attach on a page
  // about human accounts. The same ISO-validity signal already lives, in
  // context, in the censo identification funnel — lib/metrics/census.ts's
  // identificationFunnel() `isoValid` stage — so no coverage is lost.)
  const complianceCtx = buildProjectionContext(
    { role: profile.role },
    jurisdictions,
    windows.trailing12m(),
  );
  const chipSignal = await fetchChipReplacementSignal(complianceCtx);

  // AC2: every PII read leaves a trail — both the typed-query search AND the
  // no-query landing (which still exposes the first N users' name/id/role).
  // Awaited (not fire-and-forget) so the audit row is durable; the wrapper logs
  // to console.error and swallows on failure so it never breaks the render.
  await logPiiReadSafely(user.id, query, results.length, "users");

  return (
    <div className="space-y-6">
      <ScreenHeader
        underHub={underHub}
        eyebrow={base === "/admin" ? "Admin · Usuarios" : "miMAR Gobierno · Usuarios"}
        title="Usuarios"
        subtitle={
          <p className="text-md text-ln-op-ink-2">
            Buscá por nombre y proponé cambios de rol. Las búsquedas quedan registradas en el audit
            log.
          </p>
        }
      />

      {/* C5 — chip-fraud signal (Item 4). Replacements flagged fraud/duplicate
          route to human review. This is a SIGNAL, not an auto-classification. */}
      {chipSignal.flaggedForReview > 0 && (
        <OpBreach
          title={`${chipSignal.flaggedForReview} ${pluralizeEs(chipSignal.flaggedForReview, "reemplazo")} de chip ${pluralizeEs(chipSignal.flaggedForReview, "marcado")} para revisión`}
          detail={`${chipSignal.byReason.fraud_detected ?? 0} por fraude · ${chipSignal.byReason.duplicate_detected ?? 0} por duplicado · ${chipSignal.total} reemplazos en total (12m)`}
        />
      )}

      {/* Unified filter bar (F-migration 2026-07-21, off the bespoke GET
          <form>) — Rol is a registered axis ("todos los roles" is genuinely
          the no-param default). The free-text "Buscar" query is NOT an axis
          (a free-text value has no enumerable option set — an axis's
          implicit "" ⇒ blank-"Todas" option only fits a bounded value set),
          so it renders via the shared SearchFilterField child instead. */}
      <OpFilterBar
        showPeriod={false}
        axes={
          [
            {
              id: "role",
              label: "Rol",
              paramKey: "role",
              options: ROLE_FILTER_OPTIONS.map((r) => ({
                value: r,
                label: ROLE_FILTER_LABELS[r],
              })),
              current: roleFilter === "all" ? null : roleFilter,
              allLabel: "Todos los roles",
            },
          ] satisfies OpFilterAxis[]
        }
      >
        <SearchFilterField
          paramKey="q"
          value={query}
          label="Buscar"
          placeholder="Buscar por nombre"
        />
      </OpFilterBar>

      {/* Directorio hub sibling consistency (consistency sweep 2026-07-23):
          the empty-list case renders the shared LnEmptyState like the
          Servicios/Credenciales tabs, not a bare caption line. */}
      {results.length === 0 ? (
        <LnEmptyState
          title={query || roleFilter !== "all" ? "Sin resultados" : "No hay usuarios registrados"}
          description={
            query || roleFilter !== "all"
              ? "Ajustá la búsqueda o el filtro de rol."
              : "Cuando haya usuarios en tu cobertura vas a verlos acá."
          }
        />
      ) : (
        <ResultCount
          shown={results.length}
          // This query has NO limit, so everything matched is on screen — in
          // both branches. The copy this replaced said "los primeros N", which
          // claimed a cap that never existed.
          total={results.length}
          noun={pluralizeEs(results.length, "resultado")}
          ordering={query || roleFilter !== "all" ? undefined : "ordenados por rol y nombre"}
          className="text-sm text-ln-op-mute"
        />
      )}

      <BulkRevokeList
        items={results.map((u) => ({
          id: u.id,
          label: `${u.displayName} (${roleLabel(u.role)})`,
          revocable: u.role === "vet",
          content: (
            <OpCard>
              <OpCardBody>
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-md font-medium text-ln-op-ink">{u.displayName}</p>
                      {/* I1: email (rol is the pill, estado es el marker below) —
                          the opaque UUID that used to sit here told a human nothing. */}
                      <p className="text-xs text-ln-op-mute">{emailMap.get(u.id) || "Sin email"}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <OpPill tone={ROLE_TONES[u.role] ?? "neutral"}>{roleLabel(u.role)}</OpPill>
                      {u.deactivatedAt && <OpPill tone="neutral">Desactivada</OpPill>}
                    </div>
                  </div>
                  <ProposeUserActions
                    target={{ id: u.id, displayName: u.displayName, role: u.role }}
                    actorRole={profile.role}
                    // Govt/admin accounts are managed on their detail pages
                    // (create/assign-locality/revoke live there), not inline
                    // here. For an admin viewer we link to that page instead of
                    // showing a dead "sin acciones" line. Govt viewers can't
                    // reach /admin/*, so they keep the no-inline-actions notice.
                    manageHref={base === "/admin" ? deriveTargetHref(u.id, u.role) : null}
                  />
                  {u.role === "vet" && (
                    <RevokeUserActions
                      target={{
                        id: u.id,
                        displayName: u.displayName,
                        matriculaJurisdiccion: u.matriculaJurisdiccion,
                        role: u.role,
                      }}
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
        targetKind="vet"
      />

      {/* I3: test-account filter toggle — only when there is something to reveal
          or to re-hide. */}
      {(hiddenTestCount > 0 || showTestAccounts) && (
        <p>
          <Link
            href={testToggleHref}
            className="text-sm underline underline-offset-4 text-ln-op-mute hover:text-ln-op-ink-2"
          >
            {showTestAccounts
              ? "Ocultar cuentas de prueba"
              : `Mostrar cuentas de prueba (${hiddenTestCount})`}
          </Link>
        </p>
      )}

      <p className="text-sm text-ln-op-mute">
        <Link href={base} className="underline underline-offset-4 hover:text-ln-op-ink-2">
          ← Volver al panel
        </Link>
      </p>

      <DashboardFreshnessFooter ctx={complianceCtx} />
    </div>
  );
}
