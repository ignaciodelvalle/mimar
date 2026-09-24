import Link from "next/link";

import { Icon } from "@/components/Icon";
import { OpBreach } from "@/components/ui/dashboard";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { ENO_DISEASES_AR } from "@/src/modules/surveillance/domain/eno-catalog";

import { OpenInvestigationForm } from "./OpenInvestigationForm";

export default async function NuevaInvestigacionPage({
  searchParams,
}: {
  searchParams: Promise<{ diseaseCode?: string; signalId?: string }>;
}) {
  await requireAdminOrGovtOrRedirect();
  const sp = await searchParams;

  return (
    <div className="max-w-xl space-y-6">
      <Link
        href="/gob/vigilancia/investigaciones"
        className="text-md text-ln-op-mute hover:text-ln-op-ink no-underline"
      >
        &larr; Volver al listado
      </Link>

      <header>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          Investigaciones · Nueva
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink mt-1">
          Nueva investigacion de brote
        </h1>
        <p className="text-md text-ln-op-mute mt-1">
          Apertura manual. La jurisdicción se toma de tu asignación activa.
        </p>
      </header>

      <OpBreach
        title="Notificación externa no integrada"
        detail="La notificación obligatoria a SNVS/SENASA/zoonosis (Ley 15.465/60, Decreto 3640/64) no está integrada en esta versión. Realizala a través de los canales habituales de tu jurisdicción antes o después de registrar la investigación en este sistema."
        icon={<Icon name="alerta" decorative />}
      />

      <OpenInvestigationForm
        diseases={ENO_DISEASES_AR}
        prefillDiseaseCode={sp.diseaseCode}
        prefillSignalId={sp.signalId}
      />
    </div>
  );
}
