// Redirects to the pet detail page with the fin-transito sheet open.
// The full flow is now handled by OrgPetSheetMounter on the detail page.

import { permanentRedirect } from "next/navigation";

export default async function EndFosterPage({
  params,
}: {
  params: Promise<{ orgToken: string; publicToken: string }>;
}) {
  const { orgToken, publicToken } = await params;
  permanentRedirect(`/org/${orgToken}/mascotas/${publicToken}?sheet=fin-transito`);
}
