// Org portal — service offerings list. Shows every offering for the org
// (pending, approved, rejected) ordered by submission date descending.
// Members with service_offering.create can create new ones.

import { desc, eq } from "drizzle-orm";
import Link from "next/link";

import { Icon } from "@/components/Icon";
import { OpCallout, OpCard, OpCardBody, OpCardHead, OpPill } from "@/components/ui/dashboard";
import { db, serviceOfferings } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { findServiceKind } from "@/lib/reference/service-kinds";
import { pluralizeEs } from "@/lib/utils/format";
import { capRows } from "@/lib/utils/list-pagination";
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";

type StatusTone = "open" | "ok" | "danger" | "neutral";
const STATUS_PILL: Record<string, { label: string; tone: StatusTone }> = {
  pending_approval: { label: "Pendiente", tone: "open" },
  approved: { label: "Aprobado", tone: "ok" },
  rejected: { label: "Rechazado", tone: "danger" },
  paused: { label: "Pausado", tone: "neutral" },
  archived: { label: "Archivado", tone: "neutral" },
};

export default async function ServiciosPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization, membership } = await requireOrgAccessByToken(orgToken);
  const granted = await getGrantedCapabilities(membership);
  const canCreate = granted.has("service_offering.create");

  // #815 audit finding #5: previously had no .limit() at all. Fetch one extra
  // row past the cap (same fetch-N+1 pattern as adopciones/page.tsx) so a
  // truncated notice appears instead of rendering a genuinely unbounded list.
  const SERVICES_PAGE_SIZE = 200;
  const offeringRows = await db
    .select()
    .from(serviceOfferings)
    .where(eq(serviceOfferings.organizationId, organization.id))
    .orderBy(desc(serviceOfferings.submittedAt))
    .limit(SERVICES_PAGE_SIZE + 1);

  const { rows: offerings, truncated: offeringsTruncated } = capRows(
    offeringRows,
    SERVICES_PAGE_SIZE,
  );

  return (
    <div className="space-y-6">
      {/* Page header */}
      <header className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
            {organization.displayName}
          </p>
          {/* H1 matches the nav label "Servicios" (audit #17 — nav↔H1 parity). */}
          <h1 className="text-title font-semibold text-ln-op-ink">Servicios</h1>
          <p className="text-md text-ln-op-mute">
            {offerings.length === 0
              ? "Todavía no hay servicios registrados."
              : `${offerings.length} ${pluralizeEs(offerings.length, "servicio")} ${pluralizeEs(offerings.length, "registrado")}.`}
          </p>
        </div>
        {canCreate && (
          <Link
            href={`/org/${orgToken}/servicios/nuevo`}
            className="px-4 py-2 rounded-[var(--radius-md)] bg-ln-op-azul text-white text-md font-medium hover:opacity-90 transition-opacity"
          >
            + Crear servicio
          </Link>
        )}
      </header>

      {offeringsTruncated && (
        <p className="text-sm text-ln-op-mute">
          Mostrando los primeros {SERVICES_PAGE_SIZE}. Hay más servicios registrados de los que se
          muestran acá.
        </p>
      )}

      {!canCreate && offerings.length === 0 && (
        <OpCallout
          icon={<Icon name="candado" decorative />}
          title="Permiso requerido"
          body={
            <>
              Para crear servicios necesitás el permiso{" "}
              <code className="text-sm">service_offering.create</code>. Pedíselo a un administrador
              desde el panel.
            </>
          }
        />
      )}

      {offerings.length > 0 && (
        <OpCard>
          <OpCardHead title="Servicios registrados" />
          <OpCardBody className="p-0">
            <ul className="divide-y divide-ln-op-line">
              {offerings.map((o) => {
                const kind = findServiceKind(o.serviceKind);
                const pill = STATUS_PILL[o.status] ?? STATUS_PILL.pending_approval;
                return (
                  <li key={o.id}>
                    <Link
                      href={`/org/${orgToken}/servicios/${o.publicToken}`}
                      className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-ln-op-stripe transition-colors"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-md font-medium text-ln-op-ink">{o.displayName}</p>
                        <p className="text-sm text-ln-op-mute">
                          {kind?.label ?? o.serviceKind}
                          {o.priceArs !== null
                            ? ` · $${Number(o.priceArs).toLocaleString("es-AR")}`
                            : " · Campaña gratuita"}
                          {" · "}
                          {o.durationMinutes} min
                        </p>
                      </div>
                      <OpPill tone={pill.tone}>{pill.label}</OpPill>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </OpCardBody>
        </OpCard>
      )}

      <footer className="pt-4 border-t border-ln-op-line">
        <Link href={`/org/${orgToken}`} className="text-sm text-ln-op-azul hover:underline">
          ← Volver al panel
        </Link>
      </footer>
    </div>
  );
}
