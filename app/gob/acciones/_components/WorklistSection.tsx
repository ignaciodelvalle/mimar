// WorklistSection — the /gob/acciones list body: per-domain degradation
// callouts, the honest summary line, the ranked rows, and the empty states.
// Presentational (no IO) so the screen composition is render-testable with
// mocked domain results (worklist-section.test.tsx).

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCallout } from "@/components/ui/dashboard";
import { formatCount, pluralizeEs } from "@/lib/utils/format";

import { WORKLIST_DOMAIN_LABEL, type WorklistLoadResult } from "../_lib/worklist-core";
import { WorklistRow } from "./WorklistRow";

const DEGRADED_LABEL: Record<keyof WorklistLoadResult["degraded"], string> = {
  observaciones: WORKLIST_DOMAIN_LABEL.observacion,
  denuncias: WORKLIST_DOMAIN_LABEL.denuncia,
  casos: WORKLIST_DOMAIN_LABEL.caso,
};

export function WorklistSection({ result }: { result: WorklistLoadResult }) {
  const { items, totalCount, counts, degraded } = result;
  const degradedDomains = (
    Object.keys(degraded) as Array<keyof WorklistLoadResult["degraded"]>
  ).filter((k) => degraded[k]);
  const anyDegraded = degradedDomains.length > 0;

  return (
    <div className="space-y-3">
      {/* One slow/failed domain degrades ALONE — and says so. Silence here
          would present a partial list as the whole obligation set. */}
      {anyDegraded && (
        <OpCallout
          title="Lista incompleta"
          body={`No pudimos consultar a tiempo: ${degradedDomains
            .map((k) => DEGRADED_LABEL[k])
            .join(" · ")}. Las demás fuentes se muestran completas. Recargá para reintentar.`}
        />
      )}

      {items.length === 0 ? (
        anyDegraded ? (
          <LnEmptyState
            icon="circle-dot"
            title="Sin acciones para mostrar"
            description="Al menos una fuente no respondió a tiempo, así que la lista puede estar incompleta. Recargá para reintentar."
          />
        ) : (
          <LnEmptyState
            icon="circle-dot"
            title="No hay acciones que venzan en tu jurisdicción"
            description="Se consultaron observaciones antirrábicas en curso, denuncias de maltrato abiertas y casos regulatorios abiertos: ninguna obligación con plazo está pendiente en tu cobertura."
            nature="measured-zero"
          />
        )
      ) : (
        <>
          <p className="text-sm text-ln-op-mute">
            {items.length < totalCount
              ? `Se muestran las ${formatCount(items.length)} obligaciones más urgentes de ${formatCount(totalCount)} en vista`
              : `${formatCount(totalCount)} ${pluralizeEs(totalCount, "obligación con plazo", "obligaciones con plazo")}`}
            {` · ${formatCount(counts.observaciones)} ${pluralizeEs(counts.observaciones, "observación", "observaciones")} · ${formatCount(counts.denuncias)} ${pluralizeEs(counts.denuncias, "denuncia")} · ${formatCount(counts.casos)} ${pluralizeEs(counts.casos, "caso")}`}
          </p>
          <ul aria-label="Acciones que vencen, ordenadas por plazo" className="space-y-2">
            {items.map((item) => (
              <WorklistRow key={item.key} item={item} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
