// Bulk-intake CSV template download (org-pilot-pack Req 1, design D6).
// Generated from the SAME column catalog the parser uses (lib/domain/
// intake-csv.ts) — template and validation can never drift. BOM + `;` + CRLF
// so Excel with Argentina regional settings opens it correctly, accents
// intact, columns split.
//
// Capability-gated exactly like intake create: the template itself carries no
// data, but surfacing org tooling to non-members would map the org's flows.

import { NextResponse } from "next/server";

import { INTAKE_CSV_TEMPLATE_FILENAME, buildIntakeCsvTemplate } from "@/lib/domain/intake-csv";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ orgToken: string }> }) {
  const { orgToken } = await params;

  // A READ (template download): a deactivated institutional account keeps it,
  // per lib/infra/auth-guards.ts:60-70 — reads stay open, writes stop.
  const auth = await requireCapabilityForOrgToken("intake.create", orgToken, { access: "read" });
  if (auth.error !== null) {
    return new NextResponse("No autorizado", { status: 403 });
  }

  return new NextResponse(buildIntakeCsvTemplate(), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${INTAKE_CSV_TEMPLATE_FILENAME}"`,
      "Cache-Control": "no-store",
    },
  });
}
