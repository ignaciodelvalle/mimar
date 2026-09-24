import { redirect } from "next/navigation";

import { OpCard, OpCardBody, OpCardHead, OpCrumbs } from "@/components/ui/dashboard";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";

import { EditOrgForm } from "./EditOrgForm";

export default async function OrgConfigPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);

  // Only admins can edit the org profile. Non-admins see a friendly notice
  // instead of a crash or a blank redirect — they land on this URL via the nav.
  if (membership.role !== "admin") {
    redirect(`/org/${orgToken}`);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <OpCrumbs
          items={[{ label: "Panel", href: `/org/${orgToken}` }, { label: "Configuración" }]}
        />
        <h1 className="text-title font-semibold text-ln-op-ink">
          Configuración de la organización
        </h1>
        <p className="text-md text-ln-op-mute">
          Editá el perfil público de{" "}
          <strong className="text-ln-op-ink-2">{organization.displayName}</strong>.
        </p>
      </div>

      <OpCard>
        <OpCardHead title="Perfil de la organización" />
        <OpCardBody>
          <EditOrgForm organization={organization} />
        </OpCardBody>
      </OpCard>

      <p className="text-sm text-ln-op-mute">
        El tipo de organización, la jurisdicción y el estado de verificación son gestionados por el
        equipo de miMAR.
      </p>
    </div>
  );
}
