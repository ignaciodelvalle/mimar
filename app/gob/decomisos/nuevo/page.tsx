// Govt decomiso -- nuevo caso.
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md section 6.
//
// RSC shell -- loads the verified shelter/rescue_network orgs as a static list
// for the receiver combobox, then renders the client DecomisoForm component.
// Auth is enforced by requireDecomisoPrincipal (govt | admin).

import { and, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";

import { db, organizations, welfareReports } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { requireDecomisoPrincipal } from "@/lib/infra/auth-guards";
import { jurisdictionPairClause } from "@/lib/metrics/scope";
import { resolveGovtOrgForUser } from "@/src/modules/decomiso/application/resolve-govt-org";

import { DecomisoForm } from "./_components/DecomisoForm";

interface PageProps {
  searchParams: Promise<{ welfareReportId?: string; pet?: string }>;
}

// The raw welfareReports UUID must never surface to the operator (PO1: DB
// identifier leak). We keep the id as the FK the backend needs, but resolve its
// public DEN-XXXX-XXXX reference code here so the form can show that instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NuevoDecomisoPage({ searchParams }: PageProps) {
  const { welfareReportId, pet } = await searchParams;

  const { profile, jurisdictions, user } = await requireDecomisoPrincipal();

  // Executing a decomiso is anchored on a REAL sanitary_authority organization
  // (openedByOrganizationId) — executeDecomisoAction rejects any principal
  // without that membership, ADMIN INCLUDED (it has no admin bypass), plus a
  // province on the org and (for govt) at least one jurisdiction assignment.
  // Checking all of it here, before the wizard, is what keeps this page
  // honest: without it, an operator filled all four steps (photos, acta,
  // receiver) only to be told at submit that none of it could ever have been
  // accepted (found live by the 9-role external run, 2026-08-18; the admin
  // and zero-jurisdiction variants by the pre-push review of that fix).
  {
    const govtOrg = await resolveGovtOrgForUser(user.id);
    const blocked =
      !govtOrg ||
      !govtOrg.jurisdictionProvince ||
      (profile.role === "govt" && jurisdictions.length === 0);
    if (blocked) {
      return (
        <div className="max-w-2xl space-y-6">
          <header className="space-y-1">
            <nav className="text-sm text-ln-op-mute mb-4" aria-label="Breadcrumb">
              <Link
                href="/gob/decomisos"
                className="hover:text-ln-op-ink transition-colors no-underline text-ln-op-mute"
              >
                Decomisos
              </Link>
              <span className="mx-2 text-ln-op-line">{"›"}</span>
              <span className="text-ln-op-ink">Nuevo decomiso</span>
            </nav>
            <h1 className="text-title font-semibold text-ln-op-ink">Ejecutar decomiso</h1>
          </header>
          <div className="rounded-[var(--radius-md)] border border-dashed border-ln-op-line p-8 text-center space-y-2">
            <p className="text-md text-ln-op-ink font-medium">
              {!govtOrg
                ? "Para ejecutar un decomiso, tu usuario tiene que pertenecer a una autoridad sanitaria."
                : !govtOrg.jurisdictionProvince
                  ? "Tu autoridad sanitaria no tiene provincia asignada, así que no puede ejecutar decomisos."
                  : "No tenés jurisdicciones activas asignadas, así que no podés ejecutar decomisos."}
            </p>
            <p className="text-md text-ln-op-mute">
              El acta se registra a nombre de la organización, no del funcionario. Pedile al
              administrador que complete lo que falta; mientras tanto podés consultar los episodios
              de custodia desde el listado.
            </p>
            <p className="text-md">
              <Link href="/gob/decomisos" className="text-ln-op-azul no-underline hover:underline">
                Volver al listado de decomisos
              </Link>
            </p>
          </div>
        </div>
      );
    }
  }

  // Resolve the linked denuncia's public reference code from its id, so the
  // form displays DEN-XXXX-XXXX (never the raw UUID). Guard the UUID shape first
  // so a hand-crafted query param can't throw on the uuid-typed column.
  //
  // CRITICAL — jurisdiction scope: enforce the SAME predicate the maltrato detail
  // page uses (jurisdictionScopeContains). Without it, a bounded govt operator
  // could pass ANY nationwide UUID and read back that report's DEN-XXXX-XXXX
  // code — which is the lookup key for the PUBLIC receipt route — enumerating
  // reports outside their jurisdiction. An out-of-scope report, a bogus id, and
  // a missing id all resolve to null: identical output, so existence is never
  // disclosed (the notFound()-not-403 anti-enumeration invariant).
  const linkedWelfareReport =
    welfareReportId && UUID_RE.test(welfareReportId)
      ? ((
          await db
            .select({
              referenceCode: welfareReports.referenceCode,
              jurisdictionProvince: welfareReports.jurisdictionProvince,
              jurisdictionLocality: welfareReports.jurisdictionLocality,
            })
            .from(welfareReports)
            .where(eq(welfareReports.id, welfareReportId))
            .limit(1)
        )[0] ?? null)
      : null;
  const linkedWelfareReportRef =
    linkedWelfareReport &&
    (profile.role === "admin" ||
      jurisdictionScopeContains(
        jurisdictions,
        linkedWelfareReport.jurisdictionProvince,
        linkedWelfareReport.jurisdictionLocality,
      ))
      ? linkedWelfareReport.referenceCode
      : null;

  // Receiver combobox scope (DC6): a govt agent only sees verified shelters /
  // rescue_networks inside their assigned (province, locality) jurisdiction
  // pairs — never the nationwide roster. Admin has universal scope (empty
  // jurisdictions ⇒ no jurisdiction predicate). A govt with zero active
  // assignments sees no orgs (cannot leak the nationwide list).
  //
  // jurisdictionPairClause applies whole-province subsumption — see
  // lib/metrics/scope.ts. Found via authz-subsumption fence hardening
  // (2026-07-22) — same bug class as commit 68501bb4.
  // synthetic: exempt — organizations carry no seed marker (T1-P1 report).
  const jurisdictionPredicate =
    profile.role === "govt"
      ? (jurisdictionPairClause(
          [...jurisdictions],
          sql`${organizations.jurisdictionProvince}`,
          sql`${organizations.jurisdictionLocality}`,
        ) ?? sql`false`)
      : undefined;

  const receiverOrgs =
    profile.role === "govt" && jurisdictions.length === 0
      ? []
      : await db
          .select({
            id: organizations.id,
            displayName: organizations.displayName,
            orgType: organizations.orgType,
            jurisdictionProvince: organizations.jurisdictionProvince,
            jurisdictionLocality: organizations.jurisdictionLocality,
          })
          .from(organizations)
          .where(
            and(
              inArray(organizations.orgType, ["shelter", "rescue_network"]),
              eq(organizations.verified, true),
              eq(organizations.status, "active"),
              ...(jurisdictionPredicate ? [jurisdictionPredicate] : []),
            ),
          )
          .orderBy(organizations.displayName);

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-1">
        <nav className="text-sm text-ln-op-mute mb-4" aria-label="Breadcrumb">
          <Link
            href="/gob/decomisos"
            className="hover:text-ln-op-ink transition-colors no-underline text-ln-op-mute"
          >
            Decomisos
          </Link>
          <span className="mx-2 text-ln-op-line">{"›"}</span>
          <span className="text-ln-op-ink">Nuevo decomiso</span>
        </nav>
        <h1 className="text-title font-semibold text-ln-op-ink">Ejecutar decomiso</h1>
        <p className="text-md text-ln-op-mute">
          {"Ley 14.346 — incautación de animal por autoridad sanitaria. Requiere mínimo 2 adjuntos"}
          {" (foto del animal + acta administrativa)."}
        </p>
      </header>

      <DecomisoForm
        receiverOrgs={receiverOrgs}
        prefillWelfareReportId={linkedWelfareReportRef ? (welfareReportId ?? null) : null}
        prefillWelfareReportRef={linkedWelfareReportRef}
        prefillPetToken={pet ?? null}
      />
    </div>
  );
}

export const dynamic = "force-dynamic";
