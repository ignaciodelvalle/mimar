// Permanent redirect — /mis-mascotas/[publicToken]/vacunas is now an in-page
// tab at /mis-mascotas/[publicToken]?tab=vacunas. Existing links and bookmarks
// are preserved via HTTP 308 Permanent Redirect.

import { permanentRedirect } from "next/navigation";

export default async function VacunasLibretaPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  permanentRedirect(`/mis-mascotas/${publicToken}?tab=vacunas`);
}
