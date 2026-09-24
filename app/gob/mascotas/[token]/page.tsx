import Link from "next/link";
import { notFound } from "next/navigation";

import { PetSubView } from "@/app/gob/maltrato/_inspector/PetSubView";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { loadOperatorPetSubView } from "@/lib/infra/gob-pet-subview";
import { logPiiReadSafely } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

// Govt/admin operator pet profile — the destination for the omnibox pet search
// (search/omnibox-upgrade). Renders the SAME PetSubView used by the maltrato
// inspector (app/gob/maltrato/_inspector/PetSubView.tsx — purely presentational,
// no inspector coupling), fed here by loadOperatorPetSubView, which gates by the
// viewer's JURISDICTION ALONE (no linking welfare report / case required,
// unlike the inspector path — see lib/infra/gob-pet-subview.ts module header).
//
// Access is NOT widened by this route: requireAdminOrGovtOrRedirect establishes
// admin/govt authority, and loadOperatorPetSubView re-gates server-side —
// admin universal, govt scoped to jurisdictions, fail-closed on zero
// assignments. Out-of-scope or missing pet → notFound(), never leaking
// existence.

// Reads auth cookies (viewer-dependent scope gating) — never statically cache.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function GobMascotaPage({ params }: PageProps) {
  const { token } = await params;
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();

  const pet = await loadOperatorPetSubView(
    token,
    profile.role === "admin" ? { role: "admin" } : { role: "govt", jurisdictions },
  );
  if (!pet) notFound();

  // Lote B3 — the full profile is the highest-exposure PII read; list/search
  // paths already logged pii_queried, this detail view did not. Fail-soft.
  await logPiiReadSafely(profile.id, token, 1, "pet_profile");

  return (
    <div className="space-y-6">
      <Link href="/gob" className="text-sm text-ln-op-mute hover:text-ln-op-ink-2">
        ← Volver al panel
      </Link>
      <PetSubView pet={pet} />
    </div>
  );
}
