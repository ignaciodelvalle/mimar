// Govt operator case-detail. Renders the SAME role-aware case-detail content
// as the public /casos/[publicCode] route, but under the /gob layout so a
// government operator opening a case from /gob/casos KEEPS the operator rail
// and topbar instead of being dropped into the citizen chrome (PO QA §3/§9).
//
// Access is NOT widened by this route: the /gob layout already gates the
// segment to admin/govt (requireGobReadAccessOrRedirect), and CaseDetailView
// re-runs canReadCase, which still enforces the govt reader's (province,
// locality) scope. Out-of-scope cases → notFound (no existence leak). The
// explicit guard below mirrors the sibling /gob/decomisos/[publicCode] route
// so the URL is never reachable unauthenticated.

import { CaseDetailView } from "@/components/casos/CaseDetailView";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";

// Reads auth cookies (viewer-dependent PII gating) — never statically cache.
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ publicCode: string }>;
}

export default async function GobCaseDetailPage({ params }: PageProps) {
  const { publicCode } = await params;
  await requireGobReadAccessOrRedirect();
  return <CaseDetailView publicCode={publicCode} casosHref="/gob/casos" />;
}
