// ---------------------------------------------------------------------------
// WIRED (sprint 4 PR-045 — 2026-05-27)
//
// Form is now a 4-step wizard with SuccessScreen on submit (10-day
// observation reminder). Org dashboard surfacing remains pending — when a
// "Mordeduras" CTA lands, add a nav entry in
// `components/layout/nav-presets.ts`.
// ---------------------------------------------------------------------------

import Link from "next/link";

import { OpCrumbs } from "@/components/ui/dashboard";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { reportBiteFromOrgAction } from "@/src/modules/surveillance/actions";

import { OrgBiteForm } from "./OrgBiteForm";

// Org-side bite reporting. Capability `bite.report` is enforced both here
// (the form is not shown without it) and inside the action (defense in depth
// for direct submits).
export default async function NewOrgBitePage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;

  const { organization: orgFromToken } = await requireOrgAccessByToken(orgToken);
  // A page READ (the form; the action re-checks on POST with the write
  // default): a deactivated institutional account keeps it, per
  // lib/infra/auth-guards.ts:60-70 — reads stay open, writes stop.
  const auth = await requireCapability("bite.report", orgFromToken.id, { access: "read" });

  if (auth.error !== null) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <h1 className="text-2xl font-semibold text-ln-op-ink">Sin acceso</h1>
        <p className="text-md text-ln-op-ink-2">{auth.error}</p>
        <p className="text-md text-ln-op-mute">
          Podés pedir el permiso «Reportar mordeduras» desde la página de permisos de tu
          organización.
        </p>
        <div className="flex gap-4">
          <Link
            href={`/org/${orgToken}/admin/permisos`}
            className="text-sm text-ln-op-azul hover:underline"
          >
            Ver mis permisos
          </Link>
          <Link href={`/org/${orgToken}`} className="text-sm text-ln-op-azul hover:underline">
            ← Volver al panel
          </Link>
        </div>
      </div>
    );
  }

  const boundAction = reportBiteFromOrgAction.bind(null, orgToken);

  return (
    <div className="max-w-2xl space-y-6">
      <OpCrumbs
        items={[{ label: "Panel", href: `/org/${orgToken}` }, { label: "Reportar mordedura" }]}
      />

      <header className="space-y-2">
        <h1 className="text-title font-semibold text-ln-op-ink">Reportar mordedura</h1>
        <p className="text-md text-ln-op-mute">
          Registrar una mordedura que presenciaste o conocés clínicamente. Inicia automáticamente el
          período de observación antirrábica de 10 días según la legislación vigente.
        </p>
      </header>

      <OrgBiteForm action={boundAction} orgToken={orgToken} />
    </div>
  );
}
