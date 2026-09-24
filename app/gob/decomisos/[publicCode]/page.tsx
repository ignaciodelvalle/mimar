// Decomiso detail — redirect to the unified case detail page.
//
// Spec §6: "the case detail already exists — simplest: redirect to the shared
// case-detail route." Task #47: for a govt operator the redirect now targets
// the /gob-scoped case detail (/gob/casos/[publicCode]) so the operator shell
// (rail + topbar) is preserved instead of dropping into the citizen chrome.
// Access control is unchanged — canReadCase still gates the target page.
//
// Auth is not strictly required here: canReadCase in the case page handles
// access control. But we keep requireDecomisoPrincipal so the URL isn't
// accessible to unauthenticated users via the /gob prefix.

import { redirect } from "next/navigation";

import { requireDecomisoPrincipal } from "@/lib/infra/auth-guards";

interface PageProps {
  params: Promise<{ publicCode: string }>;
}

export default async function DecomisoDetailPage({ params }: PageProps) {
  const { publicCode } = await params;
  await requireDecomisoPrincipal();
  redirect(`/gob/casos/${publicCode}`);
}
