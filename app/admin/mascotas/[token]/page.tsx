import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PetSubView } from "@/app/gob/maltrato/_inspector/PetSubView";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { loadOperatorPetSubView } from "@/lib/infra/gob-pet-subview";
import { logPiiReadSafely } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";

// Admin operator pet profile — the destination for the omnibox pet search
// (search/omnibox-upgrade). Mirrors app/gob/mascotas/[token]/page.tsx; see that
// file + lib/infra/gob-pet-subview.ts module header for the jurisdiction-only
// gate design.
//
// app/admin/layout.tsx already gates the whole segment with the STRICT
// requireAdminOrRedirect (govt and everyone else land on /), same as
// app/admin/casos/[publicCode]/page.tsx. The requireAdminOrGovtOrRedirect call
// below + the govt redirect are defence in depth mirroring that sibling route,
// so this page keeps its own gate if the layout is ever relaxed. Read access
// as coming from the LAYOUT, not this guard.

// Reads auth cookies (viewer-dependent scope gating) — never statically cache.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function AdminMascotaPage({ params }: PageProps) {
  const { token } = await params;
  const session = await requireAdminOrGovtOrRedirect();
  if (session.profile.role !== "admin") redirect(`/gob/mascotas/${token}`);

  const pet = await loadOperatorPetSubView(token, { role: "admin" });
  if (!pet) notFound();

  // Lote B3 — the full profile is the highest-exposure PII read; list/search
  // paths already logged pii_queried, this detail view did not. Fail-soft:
  // a logging failure must not break the render.
  await logPiiReadSafely(session.profile.id, token, 1, "pet_profile");

  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-ln-op-mute hover:text-ln-op-ink-2">
        ← Volver al panel
      </Link>
      <PetSubView pet={pet} />
    </div>
  );
}
