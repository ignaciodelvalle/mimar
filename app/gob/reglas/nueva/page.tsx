// /gob/reglas/nueva — the wizard entry point for "Crear regla" (PO verdict
// 2026-07-23). Admin-only, same guard the deep [country]/[province]/[locality]
// create route already used — the wizard doesn't relax or duplicate authz,
// it's a different presentational path to the SAME writer.

import { and, asc, eq, ne } from "drizzle-orm";

import { OpCrumbs } from "@/components/ui/dashboard";
import { authorityUnits, db } from "@/db";
import { requireAdminOrRedirect } from "@/lib/infra/auth-guards";
import { portalBase } from "@/lib/ui/portal-base";

import { RulesWizard } from "./RulesWizard";

export const dynamic = "force-dynamic";

export default async function NuevaReglaWizardPage() {
  await requireAdminOrRedirect();
  const base = await portalBase();
  // Confirmed units below the province: a rule may be keyed on one of them
  // (localidades-por-id D4). Drafts govern nothing, so they are not offered.
  const units = await db
    .select({
      id: authorityUnits.id,
      name: authorityUnits.name,
      provinceCode: authorityUnits.provinceCode,
    })
    .from(authorityUnits)
    .where(and(eq(authorityUnits.status, "confirmed"), ne(authorityUnits.level, "provincial")))
    .orderBy(asc(authorityUnits.provinceCode), asc(authorityUnits.name));

  return (
    <div className="max-w-2xl space-y-6">
      <OpCrumbs items={[{ label: "Reglas", href: `${base}/reglas` }, { label: "Crear regla" }]} />
      <RulesWizard base={base} units={units} />
    </div>
  );
}
