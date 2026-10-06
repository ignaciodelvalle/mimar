// /admin/localidades/pendientes — the unresolved-place queue
// (localidades-por-id D9, spec "unresolved-place-queue").
//
// A case or a report whose place did not resolve to ONE catalogue row is not
// lost: its province's authority sees it (govt_scope reaches unresolved rows
// only at province level) and it waits here for a platform admin, who picks
// the right row among the ones its name could mean. Each resolution keeps who,
// when and why (place_resolutions); the event that recorded the place is
// never edited.
//
// Authz: the /admin layout gates the segment (requireAdminOrRedirect); the
// write re-checks the platform-admin capability inside its transaction.

import Link from "next/link";

import {
  OpButton,
  OpCallout,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpSelect,
} from "@/components/ui/dashboard";
import { db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { listUnresolvedPlaces } from "@/lib/place/unresolved-queue";
import { PROVINCES, provinceByCode } from "@/lib/reference/ar-provincias";
import { pluralizeEs } from "@/lib/utils/format";

import { PendingPlaceCard } from "../_components/PendingPlaceCard";

export const dynamic = "force-dynamic";

const DEFAULT_PROVINCE = "AR-B";

export default async function UnresolvedPlacesPage({
  searchParams,
}: {
  searchParams: Promise<{ provincia?: string; resuelto?: string }>;
}) {
  await requireAdminOrRedirect();
  const { provincia, resuelto } = await searchParams;
  const province =
    provinceByCode(provincia ?? DEFAULT_PROVINCE) ?? provinceByCode(DEFAULT_PROVINCE);
  const provinceCode = province?.code ?? DEFAULT_PROVINCE;
  const queue = await listUnresolvedPlaces(db, { provinceCode });

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <p className="text-sm text-ln-op-mute">
        <Link
          href={`/admin/localidades?provincia=${provinceCode}`}
          className="underline underline-offset-4 hover:text-ln-op-ink-2"
        >
          Unidades de {province?.name ?? provinceCode}
        </Link>
      </p>
      <div>
        <h1 className="m-0 text-xl font-semibold text-ln-op-ink">Lugares sin resolver</h1>
        <p className="mt-1 text-sm text-ln-op-mute">
          Casos y denuncias cuyo lugar no se pudo asignar a una sola localidad del catálogo.
          Mientras esperan acá, los ve la autoridad de la provincia. Elegí la localidad que
          corresponde: queda registrado quién lo resolvió, cuándo y por qué, y el registro original
          no se modifica.
        </p>
      </div>

      {resuelto && resuelto.trim() !== "" && (
        <output className="block">
          <OpCallout title={`Lugar resuelto: ${resuelto.trim().slice(0, 120)}`} />
        </output>
      )}

      <form method="get" className="flex items-end gap-2">
        <div>
          <label
            htmlFor="admin-pendientes-provincia"
            className="block text-xs font-medium text-ln-op-ink-2"
          >
            Provincia
          </label>
          <OpSelect
            id="admin-pendientes-provincia"
            name="provincia"
            defaultValue={provinceCode}
            size="sm"
            block={false}
          >
            {PROVINCES.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </OpSelect>
        </div>
        <OpButton type="submit" variant="ghost" size="sm">
          Ver
        </OpButton>
      </form>

      <OpCard>
        <OpCardHead
          title={`${province?.name ?? provinceCode}: ${queue.length} ${pluralizeEs(queue.length, "lugar")} sin resolver`}
        />
        <OpCardBody>
          {queue.length === 0 ? (
            <p className="text-sm text-ln-op-mute">
              No hay lugares sin resolver en esta provincia.
            </p>
          ) : (
            <ul className="divide-y divide-ln-op-line">
              {queue.map((q) => (
                <PendingPlaceCard
                  key={`${q.subjectTable}-${q.subjectId}`}
                  item={q}
                  provinceCode={provinceCode}
                />
              ))}
            </ul>
          )}
        </OpCardBody>
      </OpCard>
    </div>
  );
}
