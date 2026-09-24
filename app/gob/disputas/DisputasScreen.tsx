// Govt custody-dispute list — migrated to CaseQueue (Wave 2 Item 12).
//
// Behaviour unchanged: admin sees all, govt scoped to their jurisdiction tuples.
// The existing URL-tab filter (?tab=open|resolved) is preserved via CaseQueue's
// status filter chips which map to the same search-param semantics.
//
// F6 fusion (2026-07-22): this is the byte-identical body of the former
// /gob/disputas page.tsx, relocated so the Casos hub (app/gob/casos/page.tsx)
// can render it as its "Disputas" expediente under ?expediente=disputas.
// /gob/disputas itself now only redirects here via the hub (see
// app/gob/disputas/page.tsx) — this is a RELOCATION, not a redesign: same
// searchParams contract, same auth guard, same query logic. The nested
// detail route (/gob/disputas/[disputeToken]) is UNCHANGED.

import { Suspense } from "react";

import { CaseQueue, type CaseQueueRow } from "@/components/ui/dashboard/CaseQueue";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { custodyDisputes, db, disputeHoldsCustodyLock, isInDisputeStatus, pets } from "@/db";
import { custodyDisputesScopeClause } from "@/lib/analytics/govt-dashboards";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { KPI_CATALOG } from "@/lib/metrics/kpi-catalog";
import { type SQL, and, desc, eq, not } from "drizzle-orm";

function parseStatus(raw: string | undefined): "open" | "closed" | null {
  if (raw === "open") return "open";
  if (raw === "closed") return "closed";
  return null;
}

export type DisputasScreenProps = {
  searchParams: { status?: string };
  /**
   * True when rendered as the Casos hub's "Disputas" tab
   * (app/gob/casos/page.tsx) — see components/ui/dashboard/ScreenHeader.tsx.
   */
  underHub?: boolean;
};

export async function DisputasScreen({ searchParams: sp, underHub = false }: DisputasScreenProps) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const activeStatus = parseStatus(sp.status);

  // Fetch dispute rows filtered by active status (in-dispute vs. closed).
  // The "open" tab is the AUTHORITY WORKLIST: it must show escalated disputes
  // too, because an escalated dispute is still live and still holds the custody
  // lock (PO decision 2A, 2026-09-22). "closed" is its complement: resolved +
  // withdrawn. Both sides are derived from the ONE shared predicate, so a third
  // in-dispute state can never fall out of the worklist into "closed".
  const statusFilter =
    activeStatus === "open"
      ? disputeHoldsCustodyLock()
      : activeStatus === "closed"
        ? not(disputeHoldsCustodyLock())
        : undefined;

  // Jurisdiction scope is a SQL predicate, NOT a JS post-filter — a CABA
  // operator must never READ a Córdoba row at the DB level (AGENTS.md). Admin =
  // no restriction; govt = OR of (province,locality) pairs; govt with no
  // assignments = sql`false` (matches nothing).
  //
  // The scope predicate comes from the SAME helper the analytics "Disputas de
  // custodia" KPI uses, so the queue count and the KPI alarm always reconcile
  // (count↔queue parity). null (admin) → undefined so the filter is omitted.
  const scopeFilter: SQL | undefined =
    custodyDisputesScopeClause({ role: profile.role }, jurisdictions) ?? undefined;

  const conditions = [statusFilter, scopeFilter].filter((c): c is SQL => c !== undefined);

  const query = db
    .select({ dispute: custodyDisputes, pet: pets })
    .from(custodyDisputes)
    .innerJoin(pets, eq(pets.id, custodyDisputes.petId))
    .orderBy(desc(custodyDisputes.createdAt));

  const scoped = conditions.length > 0 ? await query.where(and(...conditions)) : await query;

  // Map dispute rows → CaseQueueRow (CaseQueue's expected shape).
  // custody_dispute status: "open" → "open", "escalated" → "escalated" (the
  // badge renders it red/"Escalado", which is the point — the arbiter must see
  // WHICH live disputes moved to judicial channels); resolved/withdrawn →
  // "closed".
  const queueRows: CaseQueueRow[] = scoped.map(({ dispute, pet }) => ({
    id: dispute.id,
    publicCode: dispute.publicToken,
    caseKind: "custody_dispute" as const,
    status:
      dispute.status === "escalated"
        ? "escalated"
        : isInDisputeStatus(dispute.status)
          ? "open"
          : "closed",
    primaryPetName: pet.name,
    primaryPetPublicToken: pet.publicToken,
    jurisdictionProvince: dispute.jurisdictionProvince,
    jurisdictionLocality: dispute.jurisdictionLocality,
    openedAt: dispute.createdAt,
    closedAt: dispute.resolvedAt ?? null,
    // Dispute detail lives at its own route (uses publicToken, not publicCode).
    detailHref: `/gob/disputas/${dispute.publicToken}`,
  }));

  return (
    <div className="space-y-6">
      <ScreenHeader
        underHub={underHub}
        eyebrow="Disputas"
        title={KPI_CATALOG.custody_disputes_open.label}
        subtitle={
          <p className="text-md text-ln-op-mute">
            {hasNationalReadScope(profile.role)
              ? "Todas las disputas en el sistema."
              : "Disputas en tu cobertura."}
          </p>
        }
      />

      <Suspense>
        <CaseQueue
          rows={queueRows}
          filters={{ kind: "custody_dispute", status: activeStatus }}
          filterBase="/gob/casos"
          extraFilterParams={{ expediente: "disputas" }}
          caption="Cola de disputas de custodia"
          emptyMessage={
            activeStatus === "open"
              ? "No hay disputas abiertas."
              : activeStatus === "closed"
                ? "No hay disputas resueltas o retiradas."
                : "No hay disputas."
          }
        />
      </Suspense>
    </div>
  );
}
