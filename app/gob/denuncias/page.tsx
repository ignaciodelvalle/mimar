// /gob/denuncias — the Denuncias hub.
//
// F1 fusion (2026-07-22, PO-approved route unification: same worker, same
// daily moment, same decision family): the hub ABSORBS Moderación and
// Maltrato as TABBED STAGES of one screen (`?etapa=moderacion|triage`),
// superseding the earlier C6a additive-hub design (3 stage cards linking out
// to their own routes). Casos remains its OWN screen — linked out, not
// embedded: a regulatory case is a different decision family with its own
// lifecycle, not a daily triage queue.
//
// /gob/moderacion and /gob/maltrato now permanently redirect here (query
// params preserved — see lib/ui/denuncias-hub-redirect.ts); their [id]
// detail routes are UNCHANGED.
//
// Default stage = "triage" (Maltrato/Ley 14.346), not "moderacion": triage is
// the daily HEAVY-TRAFFIC operational queue (C6c workqueue grammar —
// tomar/actuar/cerrar; screen-manifest's own decision for it is "¿qué
// denuncia sin asignar necesito tomar AHORA?"), while Moderación is the
// lighter, lower-volume upstream spam/abuse gate that FEEDS triage. An
// operator's default "what do I work on right now" answer is triage.
//
// The two stage screens are IMPORTED, not rewritten — this is a relocation,
// not a redesign. Each keeps its own searchParams contract, its own auth
// guard, its own query logic, byte-identical to the former standalone pages
// (see ModeracionQueueScreen / MaltratoQueueScreen).

import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { Suspense } from "react";

import Link from "next/link";

import { count } from "drizzle-orm";

import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";
import { OpCard, OpCardBody, OpCardHead, OpKpi } from "@/components/ui/dashboard";
import { db, welfareReports } from "@/db";
import { buildModerationQueueConditions } from "@/lib/analytics/govt-dashboards";
import { fetchOpenWelfareReportsCount } from "@/lib/analytics/govt-home-kpis";
import { hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { countCasesForAdmin, countCasesForGovt } from "@/lib/infra/case-queries";
import { buildProjectionContext, windows } from "@/lib/metrics";
import type { CaseKind } from "@/src/modules/cases/domain/case-kinds";

import { MaltratoQueueScreen } from "@/app/gob/maltrato/MaltratoQueueScreen";
import { ModeracionQueueScreen } from "@/app/gob/moderacion/ModeracionQueueScreen";

export const dynamic = "force-dynamic";

type Etapa = "moderacion" | "triage";
const DEFAULT_ETAPA: Etapa = "triage";

function parseEtapa(raw: string | undefined): Etapa {
  return raw === "moderacion" ? "moderacion" : DEFAULT_ETAPA;
}

/**
 * The case kind this hub's third stage is ABOUT. Named rather than inlined so
 * the count, the copy and any future list on this page cannot drift apart —
 * they drifted once already (see the count below).
 */
const ESCALATED_DENUNCIA_KIND: CaseKind = "welfare_denuncia";

// A stage-tab switch invalidates state that only makes sense under the
// PREVIOUS stage — the pagination cursor (moderación's and triage's cursor
// formats are incompatible), the triage inspector's deep-link selection
// (?caso=/&mascota=/&panel=), and the triage-only ?queue= workqueue tab.
// Domain filters (kind/severity/status) are intentionally NOT dropped — both
// stages share the exact same WelfareReportKind/Severity vocabulary, so
// carrying them over is a feature (e.g. staying on "critical" while moving
// from moderación to triage), not a bug.
const ETAPA_RESET_PARAMS = ["cursor", "caso", "mascota", "panel", "queue"] as const;

export default async function GobDenunciasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const actor = { role: profile.role } as const;
  const sp = await searchParams;
  const etapa = parseEtapa(sp.etapa);

  // Cheap, jurisdiction-scoped counts only — the tab badges + the Casos
  // link-out tile. Same predicates/fetchers each destination already used
  // (see the original hub's header comment, preserved by continuity):
  //   - Moderación: buildModerationQueueConditions, status: "pending".
  //   - Triage: fetchOpenWelfareReportsCount (catalogued KPI, C1 contract).
  //   - Caso: countCasesForAdmin/countCasesForGovt, status: "open".
  const ctx = buildProjectionContext(actor, jurisdictions, windows.trailing30d());

  const moderationWhere = buildModerationQueueConditions({
    actor,
    jurisdictions,
    status: "pending",
    // Matches the stage screen's role-derived semantics (prepush-review-3
    // fix): admin's badge counts the escalation inbox too — the badge must
    // never disagree with what the tab shows.
    includeEscalated: hasNationalReadScope(profile.role),
  });

  // BOUNDED. This Promise.all used to be awaited bare, and it is the fan-out
  // that took the hub down on staging: the 2026-08-08 Postgres upgrade killed
  // pooler connections mid-query (57P01, "terminating connection due to
  // administrator command") and /gob/denuncias.rsc answered with a 500 instead
  // of a degraded page. Three counts for tab badges are never worth losing the
  // hub over.
  //
  // loadWithTimeout is the house helper the four analytics screens already use
  // (censo, poblacion, programa, analytics) — 10s, never rejects, and it
  // attaches a rejection handler so an abandoned sibling cannot become an
  // unhandled rejection.
  const load = await loadWithTimeout(
    Promise.all([
      db.select({ n: count() }).from(welfareReports).where(moderationWhere),
      fetchOpenWelfareReportsCount(ctx),
      // KIND-FILTERED. This stage is titled "Denuncias escaladas a un caso
      // regulatorio" (below), but the count carried no `kind`, so it returned
      // EVERY open case in scope — bite incidents, lost-pet episodes, adoption
      // paperwork and, dominantly, custody disputes. Live review 2026-07-28 read
      // "ABIERTOS 28" on this stage while `kind=welfare_denuncia` returned zero
      // rows at every status: the 28 were custody files, and an official
      // following the hub's own three-step story was sent to look at them.
      //
      // Both query helpers already accept `kind` (ListCasesFor{Govt,Admin}Filters)
      // — nothing here needed building, only passing.
      hasNationalReadScope(profile.role)
        ? countCasesForAdmin({ status: "open", kind: ESCALATED_DENUNCIA_KIND })
        : countCasesForGovt(jurisdictions, { status: "open", kind: ESCALATED_DENUNCIA_KIND }),
    ]),
  );

  // DEGRADE THE BADGES, NOT THE HUB. Everything this fan-out feeds is
  // decoration: two optional tab badges and one KPI on a static link-out card.
  // The first version of this guard returned only the fallback, which threw
  // away the header, BOTH stage tabs and the Casos link — none of which depend
  // on these counts, and the stage screens carry their own guards. An operator
  // would have lost the triage queue because a badge count timed out.
  const counts = load.ok ? load.value : null;
  const moderationCount = counts?.[0]?.[0]?.n;
  const triageCount = counts?.[1]?.count;
  const casosCount = counts?.[2];

  const tabs: UrlTabItem[] = [
    { value: "moderacion", label: "Moderación", badge: moderationCount, badgeTone: "neutral" },
    {
      value: "triage",
      // Just "Triage" — the hub subtitle and the stage's own header already
      // name Ley 14.346; repeating it in the tab label was noise (PO 2026-07-22).
      label: "Triage",
      badge: triageCount,
      badgeTone: "neutral",
    },
  ];

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Denuncias</p>
        <h1 className="text-title font-semibold text-ln-op-ink">El recorrido de una denuncia</h1>
        {/* max-w-prose removed (hub-header wrap fix, validacion-A 2026-07-23):
            see app/gob/padron/page.tsx for the full rationale. */}
        <p className="text-md text-ln-op-ink-2">
          Una denuncia ciudadana pasa por moderación, triage según Ley 14.346, y puede escalar a un
          caso regulatorio. Elegí la etapa en la que querés trabajar ahora — Caso vive en su propia
          pantalla, con seguimiento formal.
        </p>
      </header>

      {/* Says the counters are missing rather than letting empty badges read
          as zero. The queues themselves are below and unaffected. */}
      {!load.ok && (
        <output className="block rounded-[var(--radius-sm)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2 text-sm text-ln-op-warn">
          No pudimos calcular los contadores de cada etapa. Las colas de abajo funcionan igual.
        </output>
      )}

      <Suspense>
        <UrlTabs
          paramKey="etapa"
          defaultValue={DEFAULT_ETAPA}
          tabs={tabs}
          resetParamsOnChange={ETAPA_RESET_PARAMS}
          aria-label="Etapa del recorrido de denuncias"
        >
          <UrlTabsContent value={etapa}>
            {etapa === "moderacion" ? (
              <ModeracionQueueScreen searchParams={sp} underHub />
            ) : (
              // C1 fix (adversarial-gob 2026-07-23): the hub's own header
              // already establishes identity for every stage, not just
              // moderación — MaltratoQueueScreen now suppresses its own
              // eyebrow/h1 under the hub the same way.
              <MaltratoQueueScreen searchParams={sp} underHub />
            )}
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>

      {/* Caso — the one stage that stays a link-out, not an embedded tab: a
          regulatory case is a different decision family (formal follow-up,
          own lifecycle), not a daily triage queue. Bug fix (qa-triage-
          2026-07-23, finding #5): this card used to sit ABOVE the stage tabs,
          so with Triage active the single BIGGEST header on the page read
          "Paso 3 · Caso" — a screen about triage visually announcing itself
          as the case step. Moved below the tabs (and visually compacted,
          `text-sm` header instead of OpCardHead's default title size) so the
          active stage's own content dominates the fold; the Caso link-out
          stays fully present, just de-emphasized to match its "step 3 of the
          journey, not today's queue" role. */}
      {/* QA del PO 2026-08-04: la tarjeta se leía como un panel huérfano al pie
          de la pantalla. La causa no era la posición (ya se había bajado por el
          hallazgo #5 de qa-triage) sino el NÚMERO: las pestañas de arriba se
          llaman "Moderación" y "Triage", sin numerar, así que "Paso 3" era lo
          único numerado de la pantalla y apuntaba a un paso 1 y un paso 2 que no
          figuran en ninguna parte.
          Y el número era además inexacto: la escalada a caso regulatorio es
          CONDICIONAL, no una etapa por la que pasa toda denuncia. "Paso 3" la
          presentaba como obligatoria. La prosa de abajo ya explica el rol; el
          número sólo prometía una secuencia que la pantalla no muestra. */}
      <OpCard>
        <OpCardHead title={<span className="text-sm font-semibold">Casos regulatorios</span>} />
        <OpCardBody className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-prose text-md text-ln-op-ink-2">
            Denuncias escaladas a un caso regulatorio, con seguimiento formal.
          </p>
          <div className="flex items-center gap-4">
            {/* No catalog descriptor fits a bare escalated-case count (no
                target/semaphore behind it) — the C1 metric-contract's "OpKpi
                only where a descriptor fits" rule (same posture the original
                hub's header comment documented for this exact tile).
                descriptorId is explicitly written as undefined (not omitted)
                so the metric-contract fence (lint:metric-contract) recognizes
                this as an intentional bare tile, not a newly-introduced gap. */}
            {/* "—" and not 0 when the count is unavailable: a zero here would
                claim there are no escalated cases, which is a different
                statement from "we could not count them". */}
            <OpKpi label="Abiertos" value={casosCount ?? "—"} descriptorId={undefined} />
            <Link
              href="/gob/casos"
              className="inline-flex text-sm font-semibold text-ln-op-azul no-underline hover:underline"
            >
              Ver casos →
            </Link>
          </div>
        </OpCardBody>
      </OpCard>
    </div>
  );
}
