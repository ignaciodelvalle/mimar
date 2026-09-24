// Permanent redirect — /mis-mascotas/[publicToken]/libreta is now an in-page
// tab at /mis-mascotas/[publicToken]?tab=libreta. Existing links and bookmarks
// are preserved via HTTP 308 Permanent Redirect.

import { permanentRedirect } from "next/navigation";

export default async function LibretaPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  permanentRedirect(`/mis-mascotas/${publicToken}?tab=libreta`);
}
