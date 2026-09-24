// Org portal — create new service offering. Capability-gated: requires
// service_offering.create. On submit the offering lands in pending_approval
// and notifications fan out to the governing authority (govt or admin fallback).

import Link from "next/link";

import { createServiceOfferingAction } from "@/app/actions/service-offerings";
import { OpBreach, OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { SERVICE_KINDS } from "@/lib/reference/service-kinds";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { ServiceOfferingForm } from "./ServiceOfferingForm";

export default async function NuevoServicioPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);

  if (!granted.has("service_offering.create")) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <OpBreach
          title="Permiso requerido"
          detail={
            <>
              Para crear servicios necesitás el permiso{" "}
              <code className="text-sm">service_offering.create</code>. Pedíselo a un administrador
              desde el panel.
            </>
          }
        />
        <Link
          href={`/org/${orgToken}`}
          className="inline-block px-4 py-2 rounded-[var(--radius-md)] bg-ln-op-azul text-white text-md font-medium hover:opacity-90 transition-opacity"
        >
          Volver al panel
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {organization.displayName}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">Nuevo servicio</h1>
        <p className="text-md text-ln-op-mute">
          Completá los datos del servicio. Una vez enviado, la autoridad competente lo revisa y
          aprueba antes de que puedas armar la agenda.
        </p>
      </header>

      <OpCard>
        <OpCardHead title="Datos del servicio" />
        <OpCardBody>
          <ServiceOfferingForm
            serviceKinds={SERVICE_KINDS}
            createAction={createServiceOfferingAction}
            orgToken={orgToken}
          />
        </OpCardBody>
      </OpCard>

      <footer className="pt-4 border-t border-ln-op-line">
        <Link
          href={`/org/${orgToken}/servicios`}
          className="text-sm text-ln-op-azul hover:underline"
        >
          ← Volver a mis servicios
        </Link>
      </footer>
    </div>
  );
}
