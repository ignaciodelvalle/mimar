import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";

import { OpCard, OpCardBody, OpCodeBadge, OpPill } from "@/components/ui/dashboard";
import { approvalRequests, db, organizations, profiles } from "@/db";
import { summarizeApprovalPayload } from "@/lib/infra/approval-payload-summary";
import { canDecideRequest } from "@/lib/infra/approval-scope";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { portalBase } from "@/lib/ui/portal-base";
import { formatDateTimeNumericAr } from "@/lib/utils/format";
import { logRequestViewedForAuthority } from "@/src/modules/organizations/application/admin-decisions/log-request-viewed";

import { matriculaRegistryFor } from "../_lib/matricula-registries";
import { ReviewActions } from "./ReviewActions";

const TYPE_LABELS: Record<string, string> = {
  role_upgrade_vet: "Matrícula veterinaria",
  role_upgrade_govt: "Rol de gobierno",
  role_upgrade_admin: "Rol de administrador",
  organization_verification: "Verificación de organización",
  govt_assignment_grant: "Nueva localidad para govt",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  approved: "Aprobada",
  rejected: "Rechazada",
  withdrawn: "Retirada",
};

const STATUS_PILL_TONE: Record<string, "open" | "ok" | "danger" | "neutral"> = {
  pending: "open",
  approved: "ok",
  rejected: "danger",
  withdrawn: "neutral",
};

// es-AR labels for the applicant's role and the target organization type.
// Mirrors the maps used on /gob/usuarios and /gob/organizaciones so the raw
// English enum values never reach the operator.
const ROLE_LABELS: Record<string, string> = {
  owner: "Dueño/a",
  vet: "Veterinario/a",
  govt: "Gobierno",
  admin: "Administrador/a",
};

const ORG_TYPE_LABELS: Record<string, string> = {
  clinic: "Clínica",
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  sanitary_authority: "Autoridad sanitaria",
  other: "Otro",
};

export default async function ReviewRequestPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const { user, profile, jurisdictions } = await requireAdminOrGovtOrRedirect();
  const base = await portalBase();

  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.publicToken, publicToken))
    .limit(1);
  if (!request) notFound();

  // Authoritative scope check (mirrors the queue filter). Out-of-scope
  // requests 404 — no info leakage about their existence.
  if (!canDecideRequest(profile, request, jurisdictions)) notFound();

  // Audit log: record the page view. Fires per render (acceptable noise
  // for an admin tool; spec §7.4 says auto-log on detail open).
  await logRequestViewedForAuthority(user.id, publicToken);

  // Curated, allowlisted projection of the payload — NEVER the raw JSON. See
  // lib/infra/approval-payload-summary.ts (AGENTS.md: no raw payload dumps).
  const payloadRows = summarizeApprovalPayload(request.type, request.payload);

  const [applicant] = await db
    .select({
      id: profiles.id,
      displayName: profiles.displayName,
      role: profiles.role,
    })
    .from(profiles)
    .where(eq(profiles.id, request.applicantUserId))
    .limit(1);

  // Contact email — auth.users holds it (no email column on profiles; same
  // service-role read as /admin/govts/[userId]). CONTACT data, not identity:
  // the identity headline is the profile display name; the email renders as a
  // demoted contact line. Degrades to no line if the read fails.
  const applicantEmail = await fetchApplicantEmail(request.applicantUserId);

  // Matrícula verification aids (UI/UX audit 2026-07): the jurisdiction the
  // applicant DECLARED for their matrícula + the consultation link for it
  // (documented public search page of the professional college — always
  // "consulta manual", see ../_lib/matricula-registries.ts).
  const isVetMatricula = request.type === "role_upgrade_vet";
  const matriculaJurisdiccion = isVetMatricula
    ? declaredMatriculaJurisdiccion(request.payload)
    : null;
  const registryLink = isVetMatricula ? matriculaRegistryFor(matriculaJurisdiccion) : null;

  let targetOrg: { displayName: string; legalName: string; orgType: string } | null = null;
  if (request.targetOrganizationId) {
    const [org] = await db
      .select({
        displayName: organizations.displayName,
        legalName: organizations.legalName,
        orgType: organizations.orgType,
      })
      .from(organizations)
      .where(eq(organizations.id, request.targetOrganizationId))
      .limit(1);
    targetOrg = org ?? null;
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <div>
        <Link
          href={`${base}/cola`}
          className="text-md text-ln-op-mute hover:text-ln-op-ink underline underline-offset-4 no-underline"
        >
          ← Volver a la cola
        </Link>
      </div>

      {/* Page header */}
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <OpPill tone={STATUS_PILL_TONE[request.status] ?? "neutral"}>
            {STATUS_LABELS[request.status] ?? request.status}
          </OpPill>
        </div>
        <h1 className="text-title font-semibold tracking-tight text-ln-op-ink">
          {TYPE_LABELS[request.type] ?? request.type}
        </h1>
        <p className="text-sm text-ln-op-mute flex flex-wrap gap-x-2 gap-y-1 items-center">
          <OpCodeBadge tone="neutral">{request.publicToken}</OpCodeBadge>
          <span>·</span>
          <span>
            {request.jurisdictionLocality}, {request.jurisdictionProvince}
          </span>
          <span>·</span>
          <span>creada {formatDateTimeNumericAr(request.createdAt)}</span>
        </p>
      </header>

      {/* Applicant — the DISPLAY NAME is the identity headline (UI/UX audit
            2026-07); the email is demoted to a contact line below it. The
            approver verifies a PERSON, not an inbox. */}
      <Section title="Aplicante">
        <p className="text-base font-semibold text-ln-op-ink">
          {applicant?.displayName ?? "Usuario"}
        </p>
        <p className="text-sm text-ln-op-mute">
          Rol actual: {ROLE_LABELS[applicant?.role ?? "owner"] ?? applicant?.role ?? "Dueño/a"}
        </p>
        {applicantEmail && <p className="text-sm text-ln-op-mute">Contacto: {applicantEmail}</p>}
      </Section>

      {/* Target org */}
      {targetOrg && (
        <Section title="Organización a verificar">
          <p className="text-md text-ln-op-ink">{targetOrg.displayName}</p>
          <p className="text-sm text-ln-op-mute">
            {targetOrg.legalName} ·{" "}
            <OpCodeBadge tone="neutral">
              {ORG_TYPE_LABELS[targetOrg.orgType] ?? targetOrg.orgType}
            </OpCodeBadge>
          </p>
        </Section>
      )}

      {/* Detalle de la solicitud — curated fields only (no raw payload). */}
      <Section title="Detalle de la solicitud">
        {payloadRows.length === 0 ? (
          <p className="text-sm text-ln-op-mute">
            Esta solicitud no tiene datos estructurados adicionales.
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
            {payloadRows.map((row) => (
              <div key={row.label} className="contents">
                <dt className="text-sm text-ln-op-mute">{row.label}</dt>
                <dd className="text-md text-ln-op-ink">{row.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Section>

      {/* Matrícula: official-registry consultation aid (UI/UX audit 2026-07).
            The matrícula number above is SELF-DECLARED — this block gives the
            approver the jurisdiction's college page to check it against. Every
            link is a documented public search page ("consulta manual"): no
            authoritative deep-link registry exists in the reference data. */}
      {isVetMatricula && (
        <Section title="Consulta del registro oficial">
          {registryLink ? (
            <p className="text-md text-ln-op-ink">
              <a
                href={registryLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ln-op-azul underline underline-offset-4"
              >
                {registryLink.label}
              </a>{" "}
              <OpCodeBadge tone="neutral">consulta manual</OpCodeBadge>
            </p>
          ) : (
            <p className="text-sm text-ln-op-mute">
              Sin registro en línea conocido para
              {matriculaJurisdiccion ? ` “${matriculaJurisdiccion}”` : " la jurisdicción declarada"}
              . Consultá al colegio profesional de esa jurisdicción antes de aprobar.
            </p>
          )}
          <p className="text-sm text-ln-op-mute">
            El número de matrícula es autodeclarado por el aplicante: verificalo contra el registro
            antes de decidir.
          </p>
        </Section>
      )}

      {/* Decision section */}
      {request.status === "pending" ? (
        <Section title="Decidir">
          <ReviewActions publicToken={request.publicToken} requestType={request.type} />
        </Section>
      ) : (
        <Section title="Decisión">
          <p className="text-md text-ln-op-ink">
            {STATUS_LABELS[request.status]}
            {request.decidedAt && ` el ${formatDateTimeNumericAr(request.decidedAt)}`}
          </p>
          {request.decisionNotes && (
            <p className="text-sm text-ln-op-mute mt-1">Notas: {request.decisionNotes}</p>
          )}
        </Section>
      )}
    </div>
  );
}

/** auth.users email for the applicant — null on any failure (the contact line
 * simply doesn't render; the page never breaks over a lookup). */
async function fetchApplicantEmail(userId: string): Promise<string | null> {
  try {
    const supabase = createAdminClient();
    const { data: authUser } = await supabase.auth.admin.getUserById(userId);
    return authUser?.user?.email ?? null;
  } catch {
    return null;
  }
}

/** The applicant-declared matrícula jurisdiction from the (jsonb) payload. */
function declaredMatriculaJurisdiccion(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).matricula_jurisdiccion;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs uppercase tracking-[0.18em] font-bold text-ln-op-mute">{title}</h2>
      <OpCard>
        <OpCardBody className="space-y-1">{children}</OpCardBody>
      </OpCard>
    </section>
  );
}
