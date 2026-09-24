// Bulk-intake CSV import page (org-pilot-pack Req 1). Capability UX mirror of
// intake/page.tsx: the server actions re-check `intake.create` defensively,
// so this guard is best-effort UX, not the security boundary.

import Link from "next/link";

import { OpCrumbs } from "@/components/ui/dashboard";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { ImportWizard } from "./ImportWizard";

export default async function ImportIntakePage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;

  const { organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);

  if (!granted.has("intake.create")) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-title font-semibold text-ln-op-ink">Permiso requerido</h1>
          <p className="text-md text-ln-op-mute">
            Para importar ingresos necesitás el permiso{" "}
            <code className="text-sm font-ln-mono">intake.create</code>. Pedíselo a un administrador
            desde el panel.
          </p>
          <Link
            href={`/org/${orgToken}`}
            className="inline-block rounded-[var(--radius-md)] bg-ln-op-azul px-4 py-2 text-md font-medium text-white hover:opacity-90 transition-opacity no-underline"
          >
            Volver al panel
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <OpCrumbs
        items={[
          { label: "Panel", href: `/org/${orgToken}` },
          { label: "Ingresos", href: `/org/${orgToken}/intake` },
          { label: "Importar CSV" },
        ]}
      />

      <header className="space-y-1">
        <p className="text-sm uppercase tracking-wider text-ln-op-mute">
          {organization.displayName}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">Importar ingresos por CSV</h1>
        <p className="text-md text-ln-op-mute">
          Descargá la plantilla, completala con los datos de los animales y subila. Vas a ver una
          vista previa con la validación de cada fila antes de confirmar; solo las filas válidas se
          importan, una por una, como ingresos reales.
        </p>
      </header>

      <ImportWizard orgToken={orgToken} />
    </div>
  );
}
