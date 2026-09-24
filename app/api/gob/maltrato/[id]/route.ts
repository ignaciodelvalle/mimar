// GET /api/gob/maltrato/[id] — welfare-report detail for the inspector (task #12).
//
// The master-detail inspector on /gob/maltrato reads a case through this route
// (client-side fetch, keyed-abort) so opening/browsing cases never re-runs the
// queue Server Component. The route re-runs the FULL institutional gate (the
// non-redirect equivalent of requireAdminOrGovtOrRedirect — see _guard.ts) and
// delegates scope + audit + projection to loadWelfareInspectorDetail:
//
//   - out-of-scope OR non-existent → 404 with a stable body, so existence never
//     leaks to a govt operator probing a report outside their jurisdiction.
//   - the coordinate-view audit (logWelfareLocationViewed) fires ON OPEN inside
//     the loader — parity with the full page's route-prefetch behavior (PO
//     decision).

import { NextResponse } from "next/server";

import { loadWelfareInspectorDetail } from "@/lib/infra/welfare-inspector-detail";

import { resolveInstitutionalGobActor } from "../../_guard";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveInstitutionalGobActor();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const { profile, role, jurisdictions } = auth.actor;

  const result = await loadWelfareInspectorDetail(
    { profile: { id: profile.id, role }, jurisdictions, user: { id: profile.id } },
    id,
  );

  // 404 for both "does not exist" and "out of your jurisdiction" — never leak.
  if (!result.ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(result.detail, { headers: { "cache-control": "no-store" } });
}
