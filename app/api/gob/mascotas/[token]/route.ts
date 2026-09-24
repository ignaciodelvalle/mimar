// GET /api/gob/mascotas/[token] — read-only pet sub-view for the inspector (#12).
//
// Second level of the SAME inspector: from a case, an operator drills into the
// subject pet in place (&mascota=<token>). This route re-runs the full
// institutional gate and delegates the LINKING-CASE jurisdiction check to
// loadGobPetSubView — this is ONE of two pet access paths (see
// lib/infra/gob-pet-subview.ts module header):
//
//   - a pet is reachable through THIS route ONLY when it is the subject of a
//     welfare report OR the primary pet of a case inside the caller's
//     jurisdiction. The OTHER path (app/gob/mascotas/[token],
//     app/admin/mascotas/[token], fed by the omnibox pet search — search/
//     omnibox-upgrade) gates by jurisdiction alone, via
//     loadOperatorPetSubView — a distinct loader, not this one.
//   - not reachable OR non-existent → 404 with a stable body (never leak that
//     the pet exists).

import { NextResponse } from "next/server";

import { loadGobPetSubView } from "@/lib/infra/gob-pet-subview";

import { resolveInstitutionalGobActor } from "../../_guard";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const auth = await resolveInstitutionalGobActor();
  if (!auth.ok) return auth.response;

  const { token } = await params;
  const { profile, role, jurisdictions } = auth.actor;

  const result = await loadGobPetSubView(
    { profile: { id: profile.id, role }, jurisdictions, user: { id: profile.id } },
    token,
  );

  if (!result.ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json(result.pet, { headers: { "cache-control": "no-store" } });
}
