// GovtsScreen — the "Cuentas gobierno" register of the Cuentas privilegiadas
// hub (privileged-accounts fusion, 2026-08-02, mirroring the F3 Directorio
// hub shape). This is the relocated body of the former standalone
// /admin/govts page (see ./page.tsx, now a permanent redirect into
// /admin/cuentas?registro=govts). The ONLY relocation changes are (a) the
// test-account toggle href now targets the hub route carrying
// `registro=govts`, and (b) the ScreenHeader renders under the hub. Every
// action is preserved: alta (+ Crear gobierno → /admin/govts/new), the
// per-account detail drill (/admin/govts/[userId], where jurisdiction
// assignment/reassignment and deactivation live), search, estado filter,
// dead-account remedy. Guard unchanged: requireAdminOrRedirect.
//
// NATIONAL OBSERVERS LIVE HERE TOO (pilot T1-P9). They are born on the same
// form (/admin/govts/new) and switched off through the same use case, so they
// are listed in the same register, marked as such, and drill into the same
// /admin/govts/[userId] page — where deactivation and credential reset are.
// They hold no localities by construction, so the locality count and the
// "sin localidades" dead state never apply to them.

import Link from "next/link";

import { and, count, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import {
  OpCard,
  OpCardBody,
  type OpFilterAxis,
  OpFilterBar,
  OpPill,
  SearchFilterField,
} from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db, govtAssignments, profiles } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import {
  DEAD_GOVT_REMEDY,
  type GovtStatusFilter,
  isDeadGovt,
  matchEmailIds,
  normalizeGovtStatus,
} from "@/lib/infra/govt-roster";
import { isTestAccount } from "@/lib/infra/test-accounts";
import { buildAuthEmailMap, createAdminClient } from "@/lib/supabase/admin";
import { pluralizeEs } from "@/lib/utils/format";
import { likeContains } from "@/lib/utils/like-helpers";

// Universal-scope roster: cap the render and tell the operator when there is
// more, so ~50 seed govts don't force a wall of unpaginated rows.
const GOVTS_PAGE_LIMIT = 50;

// Estado axis options (R4, opfilterbar-sweep-2026-07-21) — "all" IS the
// genuine no-param default here (normalizeGovtStatus), unlike casos' "open"
// default, so this is a SAFE registered `axis` — no default-trap (the
// bar's own injected blank option maps to exactly this default).
const STATUS_OPTIONS: { value: Exclude<GovtStatusFilter, "all">; label: string }[] = [
  { value: "active", label: "Activos" },
  { value: "dead", label: "Sin localidades" },
  { value: "inactive", label: "Desactivados" },
];

type GovtsSearchParams = { q?: string; status?: string; test?: string };

export async function GovtsScreen({
  searchParams: sp,
  underHub = false,
}: {
  searchParams: GovtsSearchParams;
  underHub?: boolean;
}) {
  await requireAdminOrRedirect();

  const query = (sp.q ?? "").trim();
  const status = normalizeGovtStatus(sp.status);
  const showTestAccounts = sp.test === "1";

  const supabase = createAdminClient();

  // Emails come from auth.users (no email column on profiles). C21: page through
  // ALL auth users so emails stay complete past 200. We need the full map both
  // to render emails and to resolve email-substring matches for the ?q= filter.
  const emailMap = await buildAuthEmailMap(supabase);

  // Search matches display_name (accent-insensitive ILIKE, wildcard-safe) OR
  // email (resolved to ids from the auth map — email is not a profiles column).
  const emailMatchIds = query ? matchEmailIds(emailMap, query) : [];
  const searchClause = query
    ? or(
        sql`unaccent(${profiles.displayName}) ILIKE unaccent(${likeContains(query)}) ESCAPE '\'`,
        ...(emailMatchIds.length > 0 ? [inArray(profiles.id, emailMatchIds)] : []),
      )
    : undefined;

  // Status filter pushed into SQL so the LIMIT is applied AFTER filtering.
  // "dead" = active profile holding zero active localities (cannot operate).
  const statusClause =
    status === "active"
      ? isNull(profiles.deactivatedAt)
      : status === "inactive"
        ? isNotNull(profiles.deactivatedAt)
        : status === "dead"
          ? and(
              // A national holds no localities by design; it is never "dead".
              eq(profiles.role, "govt"),
              isNull(profiles.deactivatedAt),
              sql`NOT EXISTS (SELECT 1 FROM ${govtAssignments} WHERE ${govtAssignments.userId} = ${profiles.id} AND ${govtAssignments.revokedAt} IS NULL)`,
            )
          : undefined;

  const whereClause = and(
    inArray(profiles.role, ["govt", "national"]),
    ...(searchClause ? [searchClause] : []),
    ...(statusClause ? [statusClause] : []),
  );

  // Fetch limit+1 to detect truncation without a COUNT query. Active govts sort
  // first, then by display name.
  const rawRows = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
      createdAt: profiles.createdAt,
    })
    .from(profiles)
    .where(whereClause)
    .orderBy(sql`${profiles.deactivatedAt} IS NULL DESC`, profiles.displayName)
    .limit(GOVTS_PAGE_LIMIT + 1);

  const truncated = rawRows.length > GOVTS_PAGE_LIMIT;
  const govtRows = truncated ? rawRows.slice(0, GOVTS_PAGE_LIMIT) : rawRows;

  // Active locality counts, restricted to the rows we render.
  const govtIds = govtRows.map((g) => g.id);
  const localityCounts =
    govtIds.length > 0
      ? await db
          .select({
            userId: govtAssignments.userId,
            activeCount: count(govtAssignments.id),
          })
          .from(govtAssignments)
          .where(and(inArray(govtAssignments.userId, govtIds), isNull(govtAssignments.revokedAt)))
          .groupBy(govtAssignments.userId)
      : [];

  const localityCountMap = new Map(localityCounts.map((r) => [r.userId, Number(r.activeCount)]));

  const govts = govtRows.map((g) => ({
    ...g,
    email: emailMap.get(g.id) ?? "",
    activeLocalityCount: localityCountMap.get(g.id) ?? 0,
  }));

  // I3: default the ephemeral genesis/smoke accounts OUT of the primary view so a
  // real operator is not buried under dozens of `uc-cd-*` / `*-gen-*` rows. This
  // is a UI-level filter only (production carries no such rows); the toggle below
  // reveals them. Filtering happens after the DB page, so the "primeros N" note
  // still describes the DB slice — the visible count can be smaller.
  const hiddenTestCount = showTestAccounts
    ? 0
    : govts.filter((g) => isTestAccount(g.displayName, g.email)).length;
  const visibleGovts = showTestAccounts
    ? govts
    : govts.filter((g) => !isTestAccount(g.displayName, g.email));

  // Toggle for the test-account filter — preserves the active query + status.
  // Targets the HUB route carrying this register's tab (fusion 2026-08-02).
  const testToggleHref = (() => {
    const params = new URLSearchParams({ registro: "govts" });
    if (query) params.set("q", query);
    if (status !== "all") params.set("status", status);
    if (!showTestAccounts) params.set("test", "1");
    return `/admin/cuentas?${params.toString()}`;
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <ScreenHeader
          underHub={underHub}
          title="Gobiernos"
          subtitle={
            <p className="text-sm text-ln-op-ink-2">
              Operadores institucionales con rol de gobierno, y observadores nacionales de solo
              lectura.
            </p>
          }
        />
        <Link
          href="/admin/govts/new"
          className="px-4 py-2 text-sm font-semibold bg-ln-op-azul text-white rounded-[var(--radius-md)] hover:bg-ln-op-azul-700 shrink-0"
        >
          + Crear gobierno
        </Link>
      </div>

      {/* R4 fix (opfilterbar-sweep-2026-07-21): was a bespoke GET <form>
          (submit-to-search) + a separate hand-rolled status chip <nav> —
          the divergent pre-migration pattern every other roster screen had
          already left behind. Estado is a registered axis ("Todos" is the
          genuine no-param default — normalizeGovtStatus); the free-text
          query is NOT an axis (unbounded value set), so it renders via the
          shared SearchFilterField child, same split as /gob/usuarios. Both
          commit via serverNavCommit, which preserves the hub's `registro`. */}
      <OpFilterBar
        showPeriod={false}
        axes={
          [
            {
              id: "status",
              label: "Estado",
              paramKey: "status",
              options: STATUS_OPTIONS,
              current: status === "all" ? null : status,
              allLabel: "Todos",
            },
          ] satisfies OpFilterAxis[]
        }
      >
        <SearchFilterField
          paramKey="q"
          value={query}
          label="Buscar"
          placeholder="Buscar por nombre o email"
        />
      </OpFilterBar>

      {visibleGovts.length === 0 ? (
        <div className="text-center py-12 rounded-[var(--radius-md)] border border-dashed border-ln-op-line">
          <p className="text-sm text-ln-op-mute">
            {hiddenTestCount > 0
              ? "Solo hay cuentas de prueba en esta vista."
              : query || status !== "all"
                ? "Ningún gobierno coincide con la búsqueda."
                : "Aún no hay gobiernos."}
          </p>
          {hiddenTestCount > 0 ? (
            <Link
              href={testToggleHref}
              className="mt-3 inline-block text-sm underline underline-offset-4 text-ln-op-azul hover:text-ln-op-azul-700"
            >
              Mostrar {hiddenTestCount} {pluralizeEs(hiddenTestCount, "cuenta")} de prueba
            </Link>
          ) : query || status !== "all" ? (
            // P2-2: the search/status branch was the only one of the three
            // sharing this box without a way out — `hiddenTestCount` had its
            // toggle and the true-empty case had "Crear el primer gobierno".
            // A filtered empty must stay visible (hiding it would claim there
            // are no governments), so it gets the MINIMUM instead.
            //
            // Targets the HUB route directly, like `testToggleHref` above:
            // /admin/govts is now only a redirect into the Cuentas hub (fusion
            // 2026-08-02), so linking to it would cost the operator a hop —
            // which is exactly what __tests__/link-integrity.test.ts caught.
            <Link
              href="/admin/cuentas?registro=govts"
              className="mt-3 inline-block text-sm underline underline-offset-4 text-ln-op-azul hover:text-ln-op-azul-700"
            >
              Limpiar filtros
            </Link>
          ) : (
            !query &&
            status === "all" && (
              <Link
                href="/admin/govts/new"
                className="mt-3 inline-block text-sm underline underline-offset-4 text-ln-op-azul hover:text-ln-op-azul-700"
              >
                Crear el primer gobierno
              </Link>
            )
          )}
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {visibleGovts.map((g) => (
              <GovtRow key={g.id} govt={g} />
            ))}
          </ul>
          {truncated && (
            <p className="text-sm text-ln-op-mute">
              Mostrando los primeros {GOVTS_PAGE_LIMIT}. Hay más — refiná la búsqueda o el filtro de
              estado.
            </p>
          )}
        </>
      )}

      {/* I3: test-account filter toggle. Only relevant when there is something
            to reveal (hidden test rows) or to re-hide (currently showing them). */}
      {(hiddenTestCount > 0 || showTestAccounts) && (
        <Link
          href={testToggleHref}
          className="text-sm underline underline-offset-4 text-ln-op-mute hover:text-ln-op-ink-2"
        >
          {showTestAccounts
            ? "Ocultar cuentas de prueba"
            : `Mostrar cuentas de prueba (${hiddenTestCount})`}
        </Link>
      )}

      <p className="text-sm text-ln-op-mute">
        <Link href="/admin" className="underline underline-offset-4 hover:text-ln-op-ink-2">
          {"←"} Volver al panel
        </Link>
      </p>
    </div>
  );
}

type GovtRowProps = {
  govt: {
    id: string;
    displayName: string;
    email: string;
    role: string;
    activeLocalityCount: number;
    deactivatedAt: Date | null;
  };
};

function GovtRow({ govt }: GovtRowProps) {
  const isActive = govt.deactivatedAt === null;
  // C24: an active govt with 0 active localities cannot enter /gob (needs ≥1
  // assignment) — a dead account that must be flagged, not shown as a healthy
  // "Activo · 0 localidades".
  const isNational = govt.role === "national";
  const isDead = !isNational && isDeadGovt(isActive, govt.activeLocalityCount);

  return (
    <li>
      <OpCard>
        <OpCardBody className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            <Link
              href={`/admin/govts/${govt.id}`}
              className="text-md font-semibold text-ln-op-azul hover:underline underline-offset-4"
            >
              {govt.displayName}
            </Link>
            <p className="text-sm text-ln-op-mute">{govt.email}</p>
            {/* V4: the dead-state pill diagnoses; this states the way out, so the
                roster never shows a stuck account without its next step. */}
            {isDead && <p className="text-sm text-ln-op-ink-2">{DEAD_GOVT_REMEDY}</p>}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* C24: "open" is the OpPill warn (amber) palette — see OpPill tones. */}
            {isDead && <OpPill tone="open">sin localidades — no puede operar</OpPill>}
            {isNational ? (
              <OpPill tone="neutral">Observador nacional</OpPill>
            ) : (
              <span className="text-sm text-ln-op-mute">
                {govt.activeLocalityCount} {pluralizeEs(govt.activeLocalityCount, "localidad")}
              </span>
            )}
            <OpPill tone={isActive ? "ok" : "neutral"}>
              {isActive ? "Activo" : "Desactivado"}
            </OpPill>
          </div>
        </OpCardBody>
      </OpCard>
    </li>
  );
}
