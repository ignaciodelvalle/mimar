// /gob/casos — the Casos hub.
//
// F6 fusion (2026-07-22, PO-approved route unification: the "expediente"
// family — same legal-administrative operator works both, identical
// case-file grammar of open/parties/resolve): the hub ABSORBS Disputas as a
// TABBED EXPEDIENTE (`?expediente=casos|disputas`) of one screen. A
// regulatory case and a custody dispute are different legal instruments, but
// the SAME operator triages both with the SAME open→act→resolve rhythm —
// unlike Denuncias' daily triage queue, this is the formal-follow-up family.
//
// /gob/disputas now permanently redirects here (query params preserved —
// see lib/ui/casos-hub-redirect.ts); its [disputeToken] detail route is
// UNCHANGED. Admin has no /admin/disputas twin (disputes are a /gob-only
// surface — govt jurisdiction custody disputes), so /admin/casos is
// untouched: it keeps its own single-purpose page, no tabs.
//
// Default expediente = "casos" — the higher-volume, higher-generality
// queue (spans every case kind, incl. maltrato/decomiso escalations);
// disputas is the narrower custody-specific instrument.
//
// The two expediente screens are IMPORTED, not rewritten — this is a
// relocation, not a redesign. Each keeps its own searchParams contract, its
// own auth guard, its own query logic, byte-identical to the former
// standalone pages (see CasosScreen / DisputasScreen).

import { Suspense } from "react";

import { type UrlTabItem, UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";

import { DisputasScreen } from "@/app/gob/disputas/DisputasScreen";
import { CasosScreen } from "./CasosScreen";

export const dynamic = "force-dynamic";

type Expediente = "casos" | "disputas";
const DEFAULT_EXPEDIENTE: Expediente = "casos";

function parseExpediente(raw: string | undefined): Expediente {
  return raw === "disputas" ? "disputas" : DEFAULT_EXPEDIENTE;
}

const EXPEDIENTE_TABS: UrlTabItem[] = [
  { value: "casos", label: "Casos" },
  { value: "disputas", label: "Disputas" },
];

// A tab switch invalidates state that only makes sense under the PREVIOUS
// expediente — casos' kind/province filters and keyset cursor have no
// meaning for the disputas queue (which has neither a kind/province axis nor
// pagination). `status` is intentionally NOT reset: both queues share the
// exact same open|closed|all vocabulary (disputas' parseStatus already
// treats "all" as "no filter", same as casos), so staying on e.g. "closed"
// while switching tabs is a feature, not a bug.
const EXPEDIENTE_RESET_PARAMS = ["cursor", "kind", "province"] as const;

export default async function GobCasosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const expediente = parseExpediente(sp.expediente);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">Casos</p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          ¿Qué expediente necesita mi próxima acción?
        </h1>
        {/* max-w-prose removed (hub-header wrap fix, validacion-A 2026-07-23):
            see app/gob/padron/page.tsx for the full rationale. */}
        <p className="text-md text-ln-op-ink-2">
          Casos regulatorios y disputas de custodia comparten la misma gramática de expediente —
          abrir, sumar partes, resolver. Elegí el expediente en el que querés trabajar ahora.
        </p>
      </header>

      <Suspense>
        <UrlTabs
          paramKey="expediente"
          defaultValue={DEFAULT_EXPEDIENTE}
          tabs={EXPEDIENTE_TABS}
          resetParamsOnChange={EXPEDIENTE_RESET_PARAMS}
          aria-label="Expediente de Casos"
        >
          <UrlTabsContent value={expediente}>
            {expediente === "disputas" ? (
              <DisputasScreen searchParams={sp} underHub />
            ) : (
              <CasosScreen searchParams={sp} underHub />
            )}
          </UrlTabsContent>
        </UrlTabs>
      </Suspense>
    </div>
  );
}
