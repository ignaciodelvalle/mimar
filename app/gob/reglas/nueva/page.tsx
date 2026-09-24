// /gob/reglas/nueva — the wizard entry point for "Crear regla" (PO verdict
// 2026-07-23). Admin-only, same guard the deep [country]/[province]/[locality]
// create route already used — the wizard doesn't relax or duplicate authz,
// it's a different presentational path to the SAME writer.

import { OpCrumbs } from "@/components/ui/dashboard";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { portalBase } from "@/lib/ui/portal-base";

import { RulesWizard } from "./RulesWizard";

export const dynamic = "force-dynamic";

export default async function NuevaReglaWizardPage() {
  await requireAdminOrRedirect();
  const base = await portalBase();

  return (
    <div className="max-w-2xl space-y-6">
      <OpCrumbs items={[{ label: "Reglas", href: `${base}/reglas` }, { label: "Crear regla" }]} />
      <RulesWizard base={base} />
    </div>
  );
}
