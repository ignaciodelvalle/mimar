// /gob/localidades/pendientes — the unresolved-place queue, READ-ONLY, for the
// holder of a provincial authority unit (localidades-por-id D9).
//
// A case or a denuncia whose place did not resolve to one catalogue row
// reaches only its province's unit. Its holder can see here which places wait
// and what their names could mean; resolving stays with a platform admin
// (/admin/localidades/pendientes), who records who, when and why.
//
// Scope: only the provinces a PROVINCIAL unit grant covers
// (readableQueueProvinces over public.govt_scope). A municipal or legacy
// grant sees no queue; an admin reads the full queue in /admin.

import { LnEmptyState } from "@/components/ui/EmptyState";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { db } from "@/db";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { loadGovtScope } from "@/lib/place/scope";
import { listUnresolvedPlaces, readableQueueProvinces } from "@/lib/place/unresolved-queue";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import { formatDateShort, pluralizeEs } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

const SUBJECT_LABELS: Record<string, string> = {
  cases: "Caso",
  welfare_reports: "Denuncia",
};

export default async function GobUnresolvedPlacesPage() {
  const { profile } = await requireGobReadAccessOrRedirect();
  const provinces =
    profile.role === "govt" ? readableQueueProvinces(await loadGovtScope(profile.id)) : [];

  if (provinces.length === 0) {
    return (
      <div className="space-y-6">
        <ScreenHeader title="Lugares sin resolver" />
        <LnEmptyState
          icon="lock"
          title="Sin provincia a cargo"
          description="Esta lista es para quien tiene a cargo la unidad provincial. Si te corresponde, pedile al admin que confirme tu asignación."
        />
      </div>
    );
  }

  const queues = await Promise.all(
    provinces.map(async (code) => ({
      code,
      name: provinceByCode(code)?.name ?? code,
      items: await listUnresolvedPlaces(db, { provinceCode: code }),
    })),
  );

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <ScreenHeader title="Lugares sin resolver" />
      <p className="text-sm text-ln-op-mute">
        Casos y denuncias de tu provincia cuyo lugar no se pudo asignar a una sola localidad del
        catálogo. Mientras esperan, te llegan a vos. Solo un administrador puede elegir la localidad
        que corresponde; queda registrado quién lo hizo, cuándo y por qué.
      </p>
      {queues.map((q) => (
        <OpCard key={q.code}>
          <OpCardHead
            title={`${q.name}: ${q.items.length} ${pluralizeEs(q.items.length, "lugar")} sin resolver`}
          />
          <OpCardBody>
            {q.items.length === 0 ? (
              <p className="text-sm text-ln-op-mute">
                No hay lugares sin resolver en esta provincia.
              </p>
            ) : (
              <ul className="divide-y divide-ln-op-line">
                {q.items.map((item) => (
                  <li key={`${item.subjectTable}-${item.subjectId}`} className="space-y-1 py-3">
                    <p className="m-0 text-sm text-ln-op-ink">
                      {SUBJECT_LABELS[item.subjectTable] ?? item.subjectTable}: «
                      {item.enteredLocality}»
                      <span className="ml-2 text-xs text-ln-op-mute">
                        {formatDateShort(item.createdAt)}
                      </span>
                    </p>
                    <p className="m-0 text-xs text-ln-op-mute">
                      {item.candidates.length === 0
                        ? "Ninguna localidad del catálogo tiene ese nombre."
                        : `Puede ser: ${item.candidates
                            .map((c) => (c.department ? `${c.name} (${c.department})` : c.name))
                            .join(", ")}.`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </OpCardBody>
        </OpCard>
      ))}
    </div>
  );
}
