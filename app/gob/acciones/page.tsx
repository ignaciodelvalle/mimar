// /gob/acciones — "Acciones que vencen": the deadline-ranked, jurisdiction-
// scoped obligations worklist (G5, obligations-worklist 2026-08).
//
// WHAT THIS SCREEN IS: the composition that did not exist — the 8+ existing
// bandejas each rank their OWN domain by count; none answers "¿qué obligación
// vence primero en mi jurisdicción?". This screen merges the three
// deadline-bearing domains into ONE flat list ranked by deadline (most
// overdue first), each row carrying its honest resolution affordance:
//   - Observaciones antirrábicas en curso  → "Cerrar →" (link-out)
//   - Denuncias de maltrato abiertas       → inline "Tomar" + "Resolver →"
//   - Casos regulatorios abiertos          → "Ver →" (link-out)
// Outbox and Aprobaciones are deliberately out of v1 — see worklist-io.ts.
//
// SCOPE: resolveJurisdictionScope (THE fence — the same primitive every /gob
// screen uses, never a second implementation). Govt with zero assignments
// fails closed before any query. Admin browsing /gob gets universal scope
// with the standard province/locality drill, same as /gob/casos.
//
// RESILIENCE: the 3-domain fan-out is budget-bound per domain (withDbBudget
// inside worklist-io.ts, enforced by scripts/check-db-budget.ts) — one slow
// domain degrades alone and announces itself; the screen never hangs.

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpFilterBar, ViewScopeCaption } from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";

import { WorklistSection } from "./_components/WorklistSection";
import { type WorklistScope, loadWorklist } from "./_lib/worklist-io";

export const dynamic = "force-dynamic";

export default async function GobAccionesPage({
  searchParams,
}: {
  searchParams: Promise<{ province?: string; locality?: string }>;
}) {
  const { user, profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const sp = await searchParams;

  // THE FENCE — govt narrowing only ever intersects DOWN against the
  // session's assignments; admin gets the universal scope + explicit drill.
  const {
    filteredJurisdictions,
    localities,
    allowedProvinces,
    adminSelectedProvince,
    adminSelectedLocality,
  } = await resolveJurisdictionScope({
    role: profile.role,
    jurisdictions,
    params: { province: sp.province, locality: sp.locality },
  });

  // WorklistScope's `role` is a scope KIND (universal + drill vs mandate list);
  // the read-only national role reads with the universal kind.
  const scope: WorklistScope = hasNationalReadScope(profile.role)
    ? { role: "admin", province: adminSelectedProvince, locality: adminSelectedLocality }
    : { role: "govt", jurisdictions: filteredJurisdictions };

  // C3 disclosure — caption when the URL filter narrows below the mandate.
  const narrowedView = describeNarrowedView({
    role: profile.role,
    mandateJurisdictions: jurisdictions,
    effectiveJurisdictions: filteredJurisdictions,
    adminProvince: adminSelectedProvince ?? undefined,
    adminLocality: adminSelectedLocality ?? undefined,
  });

  const header = (
    <ScreenHeader
      className="space-y-1"
      eyebrow="Bandeja operativa"
      title="Acciones que vencen"
      subtitle={
        <>
          <ViewScopeCaption scope={narrowedView} />
          <p className="text-md text-ln-op-ink-2">
            Una sola lista con las obligaciones con plazo de tu jurisdicción — observaciones
            antirrábicas, denuncias de maltrato y casos regulatorios — ordenada por vencimiento: lo
            más vencido primero.
          </p>
        </>
      }
    />
  );

  // The MANDATE is what is empty here — fail-closed before any query, same
  // posture as /gob/casos.
  if (profile.role === "govt" && jurisdictions.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <LnEmptyState
          icon="usuarios"
          title="No tenés jurisdicciones asignadas todavía."
          description="Pedile a un administrador que te asigne una jurisdicción."
        />
      </div>
    );
  }

  const result = await loadWorklist(scope, user.id);

  return (
    <div className="space-y-6">
      {header}
      <OpFilterBar showPeriod={false} jurisdiction={{ allowedProvinces, localities }} />
      <WorklistSection result={result} />
    </div>
  );
}
