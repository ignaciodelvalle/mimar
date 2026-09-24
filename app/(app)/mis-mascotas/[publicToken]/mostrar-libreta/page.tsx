// /mis-mascotas/[token]/mostrar-libreta — legacy deep-link.
//
// The standalone page was retired (lean audit 2026-07-03): it rendered the
// exact same Tier2PublicView as the merged "Compartir" sheet (ADR-7/14), so
// two surfaces edited one setting. This route now redirects to the canonical
// sheet; old bookmarks and any lingering links keep working.

import { redirect } from "next/navigation";

export default async function MostrarLibretaPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  redirect(`/mis-mascotas/${publicToken}?sheet=compartir`);
}
