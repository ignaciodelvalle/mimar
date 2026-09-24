// Govt decomiso dashboard -- custody_episode list.
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md section 6.
//
// Auth model (2026-08-18): READ is governed by jurisdiction; EXECUTION by
// authority-org membership. Two query shapes:
//   - admin: every custody_episode (universal read).
//   - govt WITH an authority org: caseKind + openedByOrganizationId +
//     jurisdictionPairClause — workflow ownership AND the jurisdictional
//     FENCE (RA-8 R3; a stale membership in another province's authority org
//     satisfies ownership alone, see decomiso-jurisdiction-fence.ts).
//   - govt WITHOUT one: caseKind + jurisdictionPairClause only, READ-ONLY —
//     any opener, same visibility /gob/casos already grants.
// Mutations (Reasignar / Devolver / the /nuevo wizard) render only when every
// server-side execution requirement holds (authority org with a province,
// and for govt at least one jurisdiction assignment) — each server action
// re-validates all of it regardless.
// ORDER BY openedAt DESC, createdAt DESC, id DESC.
// Columns: pet, status/phase, dias transcurridos, refugio receptor, accion Reasignar.

import { type SQL, and, desc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";

import {
  OpCard,
  OpCardBody,
  OpCardHead,
  OpCodeBadge,
  OpFilterBar,
  OpKpi,
  OpPill,
} from "@/components/ui/dashboard";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { DashboardFreshnessFooter } from "@/components/ui/dashboard/DashboardFreshnessFooter";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { cases, db, organizations, pets } from "@/db";
import { analyticsRetryHref, loadWithTimeout } from "@/lib/analytics/analytics-load";
import { fetchSeizures } from "@/lib/analytics/compliance-metrics";
import { requireDecomisoPrincipal } from "@/lib/infra/auth-guards";
import { buildProjectionContext } from "@/lib/metrics";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { jurisdictionPairClause, withoutSyntheticRows } from "@/lib/metrics/scope";
import { formatCount, formatDate, speciesLabel } from "@/lib/utils/format";
import { resolveGovtOrgForUser } from "@/src/modules/decomiso/application/resolve-govt-org";

import { DevolverAlDuenoButton } from "./_components/DevolverAlDuenoButton";
import { ReasignarButton } from "./_components/ReasignarButton";
import { resolveDecomisosPeriod } from "./resolve-decomisos-period";

// Human-readable labels for the seizure_motive enum (event-schemas.ts).
const SEIZURE_MOTIVE_LABELS: Record<string, string> = {
  maltrato_fisico: "Maltrato físico",
  abandono_extremo: "Abandono extremo",
  acumulacion: "Acumulación",
  trafico: "Tráfico",
  sin_refugio_critico: "Sin refugio (crítico)",
  pelea_de_perros: "Pelea de perros",
  otro: "Otro",
};

// Phase label for a custody_episode case based on spec section 13.2
function phaseLabel(status: string, receiverOrgId: string | null): string {
  if (status === "closed") return "Cerrado";
  if (status === "open" && receiverOrgId) return "Esperando aceptación del refugio";
  if (status === "open" && !receiverOrgId) return "En custodia oficial (sin refugio asignado)";
  return status;
}

type PhasePillTone = "neutral" | "open" | "triaged";

function phasePillTone(status: string, receiverOrgId: string | null): PhasePillTone {
  if (status === "closed") return "neutral";
  if (status === "open" && receiverOrgId) return "open";
  return "triaged";
}

/**
 * How long the episode HAS LASTED — which stops at its closure.
 *
 * This used to run off Date.now() unconditionally, so a closed episode kept
 * counting. A real row read "CERRADO · Abierto el 19 de junio · Cerrado el 19
 * de junio" with "36 días" in bold beside it: the episode lasted zero days, and
 * the largest number on the row said otherwise (external design review C8/U3).
 * The most prominent figure on a row lying, in a system whose whole premise is
 * that the record does not.
 */
function daysElapsed(openedAt: Date, closedAt: Date | null): number {
  const end = closedAt ? closedAt.getTime() : Date.now();
  return Math.max(0, Math.floor((end - openedAt.getTime()) / (1000 * 60 * 60 * 24)));
}

/** Header subtitle per role and mode — extracted to keep the page component
 * under the complexity fence. */
function decomisosSubtitle(role: string, readOnly: boolean): string {
  if (readOnly) {
    return role === "admin"
      ? "Todos los episodios de custodia del sistema (solo consulta)."
      : "Episodios de custodia en tu jurisdicción (solo consulta).";
  }
  return role === "admin"
    ? "Todos los episodios de custodia del sistema."
    : "Decomisos ejecutados por tu autoridad sanitaria.";
}

/** Why this principal cannot execute decomisos — mirrors, in the same order,
 * the server-side rejections in executeDecomisoAction. */
function readOnlyReason(govtOrg: { jurisdictionProvince: string | null } | null): string {
  if (govtOrg === null) {
    return "Podés consultar los episodios de custodia. Para ejecutar o gestionar decomisos, tu usuario tiene que pertenecer a una autoridad sanitaria — pedile al administrador que te asocie a la organización que corresponda.";
  }
  if (govtOrg.jurisdictionProvince === null) {
    return "Podés consultar los episodios de custodia. Tu autoridad sanitaria no tiene provincia asignada, así que no puede ejecutar decomisos — pedile al administrador que la complete.";
  }
  return "Podés consultar los episodios de custodia. No tenés jurisdicciones activas asignadas, así que no podés ejecutar decomisos — pedile al administrador que te asigne una.";
}

export default async function DecomisosDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const session = await requireDecomisoPrincipal();

  // READ is governed by jurisdiction; EXECUTION by authority-org membership.
  //
  // These are different credentials and this page used to conflate them: a
  // govt operator without a sanitary_authority membership got a hard "contactá
  // al administrador" dead-end, while the rail said "Decomisos" and /nuevo
  // happily opened a wizard whose submit would fail on the same missing org
  // (found live by the 9-role external run, 2026-08-18 — both CABA and PBA
  // accounts). But that operator can already read every one of these episodes
  // through /gob/casos (canReadCase fences on session.jurisdictions alone), so
  // hiding the LIST protected nothing — it just contradicted the navigation.
  //
  // Now: no authority org → read-only, jurisdiction-fenced view (any opener),
  // with the execution requirement stated instead of implied. With an org →
  // unchanged: ownership + jurisdiction, mutations enabled.
  let govtOrgId: string | null = null;
  let jurisdictionFence: SQL | undefined;
  // Resolved for EVERY role — executeDecomisoAction requires the authority
  // org unconditionally (no admin bypass), so exempting admin here left the
  // exact dead-end this page removes for govt: a platform admin without a
  // sanitary_authority membership saw live mutation buttons that could only
  // fail at submit (pre-push review of this very commit).
  const govtOrg = await resolveGovtOrgForUser(session.user.id);
  // Read-only whenever ANY server-side execution requirement is missing:
  // no authority org, no province on it, or (govt only) zero jurisdiction
  // assignments — all three are submit-time rejections in decomiso.ts.
  const readOnly =
    govtOrg === null ||
    govtOrg.jurisdictionProvince === null ||
    (session.profile.role === "govt" && session.jurisdictions.length === 0);
  if (session.profile.role !== "admin") {
    govtOrgId = govtOrg?.id ?? null;

    // The SQL mirror of jurisdictionScopeContains — same whole-province
    // subsumption the CREATE guard and canReadCase apply, so the list can never
    // disagree with the detail page about what this operator governs.
    // `?? sql\`false\`` is the fail-closed leg: zero assignments means zero
    // rows, never an absent predicate.
    // T1-P1: a decomiso over a synthetic pet is synthetic — only admin sees it.
    jurisdictionFence =
      withoutSyntheticRows(
        session.profile.role,
        "cases",
        jurisdictionPairClause(
          session.jurisdictions.map((j) => ({ province: j.province, locality: j.locality })),
          sql`${cases.jurisdictionProvince}`,
          sql`${cases.jurisdictionLocality}`,
        ) ?? sql`false`,
      ) ?? sql`false`;
  }

  const sp = await searchParams;
  // Default stays trailing 30d (pre-existing hardcoded behavior) — see
  // resolve-decomisos-period.ts for why this can't just be
  // resolveAnalyticsPeriod(sp) directly.
  const period = resolveDecomisosPeriod(sp);

  const rows = await db
    .select({
      c: cases,
      petName: pets.name,
      petToken: pets.publicToken,
      petSpecies: pets.species,
      receiverName: organizations.displayName,
    })
    .from(cases)
    .leftJoin(pets, eq(pets.id, cases.primaryPetId))
    .leftJoin(organizations, eq(organizations.id, cases.receiverOrganizationId))
    .where(
      session.profile.role === "admin"
        ? eq(cases.caseKind, "custody_episode")
        : and(
            eq(cases.caseKind, "custody_episode"),
            // Ownership narrowing only applies when an authority org binds the
            // operator; the read-only view shows every episode inside the
            // jurisdiction fence regardless of which authority opened it —
            // the same visibility /gob/casos already grants.
            ...(govtOrgId ? [eq(cases.openedByOrganizationId, govtOrgId)] : []),
            jurisdictionFence,
          ),
    )
    // openedAt alone is not unique — most custody_episode rows share an
    // identical batch-seeded timestamp (verified against the local DB), so
    // `ORDER BY opened_at DESC` with no tiebreaker leaves ties in whatever
    // order the seq scan happens to hand back, which for a bulk-inserted
    // batch reads out in roughly insertion order — i.e. the oldest case in
    // that tied block renders FIRST and the newest LAST, the exact "starts
    // at the end" symptom reported.
    //
    // `createdAt` recovers TRUE insertion recency for these ties: no writer
    // (production openCase() in cases-repository.ts, nor any seed script)
    // ever sets `created_at` explicitly — it is always the DB-side
    // `defaultNow()` timestamp captured at the moment the row actually landed.
    // Seed scripts DO deliberately backdate `opened_at` (a business-semantic
    // date) to a shared value across a batch, but each `cases` row is still
    // inserted via its own sequential, non-transactional `INSERT` statement
    // (verified: no `db.transaction` wraps the seed loops), so `created_at`
    // is a real, monotonically increasing timestamp distinguishing "which of
    // these same-opened_at rows landed most recently." (In real production
    // writes, `openedAt` is never set explicitly either — both columns get
    // the identical `defaultNow()` snapshot from the same INSERT, so
    // `createdAt` adds no information there; it only resolves the seed-batch
    // case, which is exactly the reported symptom.)
    //
    // `id DESC` remains the final determinism guard this project already uses
    // for newest-first case lists (lib/infra/case-queries.ts
    // listCasesForGovt/listCasesForAdmin) for the residual case where even
    // `created_at` ties (e.g. a hypothetical future batch INSERT). It does
    // NOT recover true sub-second recency on its own (id is a random UUID) —
    // `createdAt` is what does that here.
    .orderBy(desc(cases.openedAt), desc(cases.createdAt), desc(cases.id))
    .limit(200);

  // Verified-orgs list for the Reasignar combobox (V9 usability fix): same
  // eligibility gate reassign-decomiso.ts's validateReceiverOrg enforces
  // server-side (verified + active + shelter/rescue_network) — this is a
  // display-only convenience list, not a security boundary; the use-case
  // re-validates on submit regardless of what's shown here.
  const receiverOrgs = readOnly
    ? []
    : await db
        .select({
          id: organizations.id,
          displayName: organizations.displayName,
          orgType: organizations.orgType,
        })
        .from(organizations)
        .where(
          and(
            eq(organizations.verified, true),
            eq(organizations.status, "active"),
            inArray(organizations.orgType, ["shelter", "rescue_network"]),
          ),
        )
        .orderBy(organizations.displayName)
        .limit(200);

  // D5 seizures (Item 4) — shelter_intake_recorded(intake_reason='seizure')
  // in the selected period (default trailing 30d), grouped by seizure_motive,
  // jurisdiction-scoped. Admin sees universal scope; govt is scoped to their
  // assigned jurisdictions.
  const seizuresCtx = buildProjectionContext(
    { role: session.profile.role },
    session.jurisdictions,
    period,
  );
  // Header + period bar render in BOTH the data and the degraded branch (same
  // shape as app/gob/censo/CensoScreen.tsx). Neither depends on fetchSeizures,
  // so the bare fallback was taking away the period control that would have
  // narrowed the query that timed out — and, worse here, the "+ Nuevo decomiso"
  // action, which does not read the DB at all and is the whole point of the
  // screen for an operator in the field.
  const shell = (
    <>
      <div className="flex items-center justify-between">
        <ScreenHeader
          eyebrow="Ley 14.346"
          title="Decomisos"
          subtitle={
            <p className="text-md text-ln-op-mute">
              {decomisosSubtitle(session.profile.role, readOnly)}
            </p>
          }
        />
        {/* The execute entry point only renders when the submit can actually
            succeed — executeDecomisoAction rejects any principal without a
            sanitary_authority membership, so offering the wizard here would be
            a four-step dead-end. */}
        {!readOnly && (
          <Link
            href="/gob/decomisos/nuevo"
            className="px-3 py-1.5 rounded-[var(--radius-md)] bg-ln-op-azul text-white text-md font-medium hover:bg-ln-op-azul-700 transition-colors no-underline"
          >
            {"+ Nuevo decomiso"}
          </Link>
        )}
      </div>

      {/* Read-only mode states the execution requirement instead of implying
          it with missing buttons. */}
      {readOnly && (
        <p className="text-md text-ln-op-mute rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe px-4 py-3">
          {readOnlyReason(govtOrg)}
        </p>
      )}

      {/* Unified filter bar — period only (no jurisdiction/domain axes: rows
          are already narrowed by the auth model above — ownership+fence, or
          fence alone in read-only mode — and the seizures KPI below is
          the only period-aware element on this screen). Default preset "30d"
          matches the pre-existing hardcoded windows.trailing30d() behavior. */}
      <OpFilterBar period={{ defaultPreset: "30d" }} />
    </>
  );

  // BOUNDED (outage pass 2026-08-09) — a GROUP BY over the seizure ledger.
  const load = await loadWithTimeout(fetchSeizures(seizuresCtx));
  if (!load.ok) {
    return (
      <div className="space-y-6">
        {shell}
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref={analyticsRetryHref("/gob/decomisos")}
        />
      </div>
    );
  }
  const seizures = load.value;

  return (
    <div className="space-y-6">
      {/* Header + filter bar — hoisted above the load so the degraded branch
          keeps them (see the `shell` definition). */}
      {shell}

      {/* D5 — seizures this period (default trailing 30d) + by-motive breakdown (Ley 14.346). */}
      <section aria-label="Decomisos del período seleccionado" className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <OpKpi
            label={KPI_CATALOG.seizures_period_count.label}
            value={formatCount(seizures.total)}
            tone={seizures.total > 0 ? "warn" : "neutral"}
            sub="incautaciones por Ley 14.346"
            info={{
              definition:
                "Total de eventos shelter_intake_recorded con intake_reason='seizure' en el período seleccionado, scoped a la jurisdicción del operador.",
              formula:
                "COUNT(shelter_intake_recorded WHERE intake_reason='seizure', período seleccionado) scoped",
            }}
            descriptorId="seizures_period_count"
          />
        </div>
        {seizures.byMotive.length > 0 && (
          <OpCard>
            <OpCardHead title="Decomisos por motivo (período seleccionado)" />
            <OpCardBody className="p-0">
              <ul className="divide-y divide-ln-op-line-2">
                {seizures.byMotive.map((m) => (
                  <li
                    key={m.motive}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 odd:bg-ln-op-stripe"
                  >
                    <span className="text-md text-ln-op-ink">
                      {SEIZURE_MOTIVE_LABELS[m.motive] ?? m.motive}
                    </span>
                    <span className="text-md font-semibold text-ln-op-ink tabular-nums">
                      {m.count}
                    </span>
                  </li>
                ))}
              </ul>
            </OpCardBody>
          </OpCard>
        )}
      </section>

      {/* A control that filters ONE block must not look like it filters the
          screen. The period selector above drives the seizures KPI and nothing
          else (see the OpFilterBar comment) — the list below is the most recent
          200 episodes, period-independent. Unlabelled, that reads as a bug:
          narrow the period, watch the KPI fall, watch the list not move. Worse
          when the list is EMPTY, where "no hay decomisos" silently invites the
          reading "…en este período", which the query never asked.

          Making the list period-aware is a product decision and is NOT taken
          here; this states the boundary the code already has. */}
      <section aria-label="Episodios de custodia registrados" className="space-y-3">
        <div className="space-y-0.5">
          <h2 className="text-md font-semibold text-ln-op-ink">
            Episodios de custodia registrados
          </h2>
          <p className="text-md text-ln-op-mute">
            El período seleccionado no filtra este listado: sólo afecta los indicadores de arriba.
            Se muestran los 200 episodios más recientes, sin importar su fecha de apertura.
          </p>
        </div>
        {rows.length === 0 ? (
          <div className="rounded-[var(--radius-md)] border border-dashed border-ln-op-line p-12 text-center space-y-2">
            <p className="text-md text-ln-op-mute">
              {readOnly
                ? "No hay decomisos registrados en tu jurisdicción todavía."
                : "No hay decomisos registrados todavía."}
            </p>
            {!readOnly && (
              <p className="text-sm text-ln-op-mute">
                {'Usá el botón "Nuevo decomiso" para registrar una incautación por Ley 14.346.'}
              </p>
            )}
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map(({ c, petName, petToken, petSpecies, receiverName }) => {
              const days = daysElapsed(c.openedAt, c.closedAt ?? null);
              // Mutations additionally require the authority-org binding —
              // both server actions re-resolve and reject without it, so in
              // read-only mode the buttons would be dead-ends, not shortcuts.
              const canReassign =
                !readOnly && c.status === "open" && Boolean(c.receiverOrganizationId);
              // The episode is still in the OPENING govt org's direct custody
              // while status='open' (any accept/handoff closes THIS case and
              // opens a new one for the receiver — see accept-decomiso-handoff.ts).
              // Subject-kind (registered pet with a former owner) is validated
              // server-side; unowned strays fail cleanly with a clear error.
              const canReturnToOwner = !readOnly && c.status === "open";

              return (
                <li key={c.id}>
                  <OpCard>
                    <OpCardBody>
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          {/* Case code + pet. Both identifiers go through the
                              shared OpCodeBadge atom (queue-anatomy alignment,
                              2026-07-30) instead of bare mono text: blue for the
                              row's own case code (the linked identifier, same
                              tone CaseQueue gives it), neutral for the pet token,
                              which is a reference to another record, not this
                              row's key. */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link
                              href={`/gob/casos/${c.publicCode}`}
                              className="no-underline"
                              aria-label={`Ver caso ${c.publicCode}`}
                            >
                              <OpCodeBadge tone="blue">{c.publicCode}</OpCodeBadge>
                            </Link>
                            {petName && (
                              <span className="text-md text-ln-op-ink">
                                {petName}
                                <span className="text-ln-op-mute">
                                  {" "}
                                  ({petSpecies ? speciesLabel(petSpecies) : "—"})
                                </span>
                              </span>
                            )}
                            {petToken && <OpCodeBadge tone="neutral">{petToken}</OpCodeBadge>}
                          </div>

                          {/* Phase pill */}
                          <OpPill tone={phasePillTone(c.status, c.receiverOrganizationId)}>
                            {phaseLabel(c.status, c.receiverOrganizationId)}
                          </OpPill>
                        </div>

                        {/* Days elapsed */}
                        <div className="text-right flex-shrink-0">
                          <p className="text-lg font-bold text-ln-op-ink tabular-nums">{days}</p>
                          <p className="text-sm text-ln-op-mute">{days === 1 ? "día" : "días"}</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 flex-wrap text-sm text-ln-op-mute mt-3">
                        <div className="space-y-0.5">
                          <p>
                            Abierto el {formatDate(c.openedAt)}
                            {c.closedAt ? ` · Cerrado el ${formatDate(c.closedAt)}` : ""}
                          </p>
                          {receiverName && (
                            <p>
                              Refugio:{" "}
                              <span className="text-ln-op-ink font-medium">{receiverName}</span>
                            </p>
                          )}
                          {!c.receiverOrganizationId && c.status === "open" && (
                            <p className="text-ln-op-warn">Sin refugio asignado</p>
                          )}
                          {/* The reversibility window, named (PO fix list
                              2026-08-17, item 2c). "Devolver al dueño" is only
                              reachable while THIS authority still holds the
                              shelter_custody row — validateReturnCustodyToOwner
                              requires it — and accept-decomiso-handoff ends that
                              row the moment the refugio accepts. The window
                              therefore closes on a third party's decision, not
                              on anything the funcionario does or a clock he can
                              read, and until now nothing on this screen said
                              so. */}
                          {canReturnToOwner && (
                            <p className="text-ln-op-mute">
                              Podés devolver o reasignar hasta que el refugio acepte el traspaso;
                              después la custodia es suya y esta autoridad ya no puede devolverla.
                            </p>
                          )}
                        </div>

                        <div className="flex gap-2">
                          <Link
                            href={`/gob/casos/${c.publicCode}`}
                            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-ln-op-line text-ln-op-ink hover:bg-ln-op-stripe transition-colors no-underline text-sm"
                          >
                            Ver caso
                          </Link>
                          {canReassign && (
                            <ReasignarButton
                              casePublicCode={c.publicCode}
                              currentReceiverName={receiverName ?? "el refugio actual"}
                              currentReceiverOrgId={c.receiverOrganizationId}
                              receiverOrgs={receiverOrgs}
                            />
                          )}
                          {canReturnToOwner && (
                            <DevolverAlDuenoButton casePublicCode={c.publicCode} />
                          )}
                        </div>
                      </div>
                    </OpCardBody>
                  </OpCard>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <DashboardFreshnessFooter ctx={seizuresCtx} />
    </div>
  );
}

export const dynamic = "force-dynamic";
