// Org-side welfare denuncia entry point.
//
// A member of a verified org with role in {admin, coordinator, member,
// vet_individual} submits a welfare denuncia attributed to the org.
// The server action (createOrgWelfareReportAction):
//   - forces severity='critical' (OA2)
//   - notifies govt + admin urgently (OA4)
//   - skips moderation auto-flag (OA7)
//   - emits multi-source escalation when ≥2 orgs report the same subject (OA9)
//
// Volunteer + foster roles do NOT have welfare.report capability (OA11)
// and will see a friendly explainer instead of the form.

import { and, eq, isNull } from "drizzle-orm";
import Link from "next/link";

import { WelfareReportForm } from "@/app/(public)/denuncias/nueva/WelfareReportForm";
import { OpBreach, OpCallout, OpCrumbs } from "@/components/ui/dashboard";
import { db, organizationMemberships, profiles } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { createOrgWelfareReportAction } from "@/src/modules/welfare/actions";

const ALLOWED_ROLES = new Set(["admin", "coordinator", "member", "vet_individual"]);

export default async function OrgNuevaDenunciaPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { user, organization } = await requireOrgAccessByToken(orgToken);

  const [membership] = await db
    .select({ role: organizationMemberships.role })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organization.id),
        eq(organizationMemberships.userId, user.id),
        isNull(organizationMemberships.leftAt),
      ),
    )
    .limit(1);

  const isAllowed = !!membership && ALLOWED_ROLES.has(membership.role) && organization.verified;

  if (!isAllowed) {
    return (
      <div className="max-w-2xl space-y-6">
        <OpCrumbs
          items={[{ label: "Panel", href: `/org/${orgToken}` }, { label: "Nueva denuncia" }]}
        />
        <h1 className="text-title font-semibold text-ln-op-ink">
          Reporte de maltrato — solo para roles institucionales
        </h1>
        <OpBreach
          title={
            !organization.verified ? "Organización no verificada" : "Rol sin acceso a este canal"
          }
          detail={
            !organization.verified
              ? `${organization.displayName} todavía no fue verificada por miMAR. El canal profesional de reporte se habilita una vez que la verificación esté aprobada.`
              : `Tu rol actual dentro de la organización (${membership?.role ?? "—"}) no habilita este canal. Pediselo a un coordinador o admin de la organización para que lo emita en tu nombre.`
          }
        />
        <p className="text-md text-ln-op-mute">
          Mientras tanto, podés usar el{" "}
          <Link href="/denuncias/nueva" className="text-ln-op-azul hover:underline no-underline">
            canal público de denuncias
          </Link>
          .
        </p>
      </div>
    );
  }

  // Resolve the reporter's display name for the banner.
  const [reporterProfile] = await db
    .select({ displayName: profiles.displayName })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  // Bind orgToken so the form can use the standard FormAction signature.
  const boundAction = createOrgWelfareReportAction.bind(null, orgToken);

  return (
    <div className="max-w-xl space-y-8">
      <OpCrumbs
        items={[
          { label: "Panel", href: `/org/${orgToken}` },
          { label: "Maltrato", href: `/org/${orgToken}/maltrato/recibidos` },
          { label: "Nueva denuncia" },
        ]}
      />

      <header className="space-y-2">
        <h1 className="text-title font-semibold text-ln-op-ink">Nueva investigación de maltrato</h1>
        <p className="text-md text-ln-op-mute">
          Canal profesional: tu reporte se procesa con prioridad crítica y notifica inmediatamente a
          las autoridades de la jurisdicción.
        </p>
      </header>

      <OpCallout
        title="Reportando como organización"
        body={
          <>
            <strong>{organization.displayName}</strong> · {reporterProfile?.displayName ?? "vos"} (
            {membership?.role})
          </>
        }
      />

      <OpCallout
        title="Particularidades del canal profesional"
        body={
          <ul className="list-disc pl-5 space-y-1 text-sm">
            <li>
              Severidad <strong>crítica automática</strong> — tu rol profesional eleva la prioridad
              sin importar lo que selecciones abajo.
            </li>
            <li>
              <strong>Mínimo 1 archivo de evidencia</strong> y descripción de al menos 100
              caracteres — la accountability institucional exige sustento.
            </li>
            <li>
              No pasa por moderación previa: vos sos responsable institucionalmente del reporte.
            </li>
          </ul>
        }
      />

      {/* descriptionMinLength mirrors createOrgWelfareReportAction's own check
          (welfare/actions.ts:1365). The header above this form already states
          100; without the prop the field below it said 20. */}
      <WelfareReportForm
        action={boundAction}
        isAnonymous={false}
        evidenceRequired
        descriptionMinLength={100}
      />

      <footer className="pt-4 border-t border-ln-op-line">
        <p className="text-sm text-ln-op-mute">
          Ley Nacional 14.346 (1954) — Malos tratos y actos de crueldad contra animales.
        </p>
      </footer>
    </div>
  );
}
