// Org-scope case index — migrated to CaseQueue (UX audit 1.3b casos).
//
// Renders the full CaseQueue with:
//   - Status filter chips (Todos / Abiertos / Cerrados) — URL-driven via
//     CaseQueue's built-in STATUS_OPTIONS.
//   - Kind filter chips above the queue (only shown when the org has multiple
//     case kinds, same as the previous list surface).
//   - Per-row SLA/age badge (escalated tone past CASE_SLA_WARNING_DAYS) via
//     the ageCaseDays helper baked into CaseQueue.
//   - No bulk actions: org cases have no simple approve/reject operation
//     analogous to adoptions. Bulk is omitted intentionally.
//
// Data: listCasesForOrg (org as opener, active ownership holder, or the
// receiver of a titular's rehome_request). Filters are pushed into SQL — no
// in-memory filtering. Kinds with their own org screen
// (ORG_CASE_KINDS_ROUTED_ELSEWHERE) are excluded here and pointed to below.

import Link from "next/link";
import { Suspense } from "react";

import { OpCrumbs } from "@/components/ui/dashboard";
import { CaseQueue, type CaseQueueRow } from "@/components/ui/dashboard/CaseQueue";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { listCaseKindDistributionForOrg, listCasesForOrg } from "@/lib/infra/case-queries";
import {
  type CaseKind,
  ORG_CASE_KINDS_ROUTED_ELSEWHERE,
  caseKindLabel,
  isCaseKind,
  orgRoutedElsewhereDestination,
} from "@/src/modules/cases/domain/case-kinds";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseStatus(raw: string | undefined): "open" | "closed" | null {
  if (raw === "open") return "open";
  if (raw === "closed") return "closed";
  return null;
}

function filterChipCls(active: boolean) {
  return [
    "rounded-full border px-3 py-[5px] text-sm no-underline transition-colors",
    active
      ? "border-ln-op-azul bg-ln-op-azul text-white"
      : "border-ln-op-line text-ln-op-ink hover:bg-ln-op-stripe",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface PageProps {
  params: Promise<{ orgToken: string }>;
  searchParams: Promise<{ kind?: string; status?: string }>;
}

export default async function OrgCasosPage({ params, searchParams }: PageProps) {
  const { orgToken } = await params;
  const { kind: kindParam, status: statusParam } = await searchParams;

  const { organization } = await requireOrgAccessByToken(orgToken);

  const activeKind: CaseKind | null = isCaseKind(kindParam ?? "") ? (kindParam as CaseKind) : null;
  const activeStatus = parseStatus(statusParam);

  const [{ items, truncated }, presentKinds] = await Promise.all([
    listCasesForOrg(organization.id, {
      kind: activeKind,
      status: activeStatus,
      excludeKinds: ORG_CASE_KINDS_ROUTED_ELSEWHERE,
    }),
    listCaseKindDistributionForOrg(organization.id, {
      excludeKinds: ORG_CASE_KINDS_ROUTED_ELSEWHERE,
    }),
  ]);

  // Where the routed-out kinds live, said once under the header so a member
  // looking for a transfer here is sent to the screen that has it.
  const routedElsewhere = ORG_CASE_KINDS_ROUTED_ELSEWHERE.map((k) =>
    orgRoutedElsewhereDestination(orgToken, k),
  ).filter((d): d is { href: string; label: string } => d !== null);

  // Base URL for CaseQueue's status filter chips (preserves ?kind= when set).
  function statusBase(): string {
    if (!activeKind) return `/org/${orgToken}/casos`;
    return `/org/${orgToken}/casos?kind=${activeKind}`;
  }

  // Kind filter href (preserves ?status= when set).
  function kindHref(k: CaseKind | null): string {
    const p = new URLSearchParams();
    if (k) p.set("kind", k);
    if (activeStatus) p.set("status", activeStatus);
    const qs = p.toString();
    return `/org/${orgToken}/casos${qs ? `?${qs}` : ""}`;
  }

  // Map CaseListItem → CaseQueueRow (shapes are identical except detailHref).
  const queueRows: CaseQueueRow[] = items.map((c) => ({
    id: c.id,
    publicCode: c.publicCode,
    caseKind: c.caseKind,
    status: c.status,
    primarySubjectKind: c.primarySubjectKind,
    primaryPetName: c.primaryPetName,
    primaryPetPublicToken: c.primaryPetPublicToken,
    jurisdictionProvince: c.jurisdictionProvince,
    jurisdictionLocality: c.jurisdictionLocality,
    openedAt: c.openedAt,
    closedAt: c.closedAt,
    // Detail route uses publicCode (not orgToken-scoped — cases are cross-org
    // public records accessible via the canonical /casos/[publicCode] route).
    detailHref: `/casos/${c.publicCode}`,
  }));

  const emptyMessage =
    activeStatus === "open"
      ? "No hay casos abiertos."
      : activeStatus === "closed"
        ? "No hay casos cerrados."
        : "No hay casos en esta cola.";

  return (
    <div className="space-y-6">
      {/* Breadcrumbs (audit #18 — casos had only an H1, no breadcrumb). */}
      <OpCrumbs items={[{ label: "Panel", href: `/org/${orgToken}` }, { label: "Casos" }]} />
      <header className="space-y-1">
        <h1 className="text-title font-semibold text-ln-op-ink">Casos</h1>
        <p className="text-md text-ln-op-mute">
          Expedientes donde {organization.displayName} abrió el caso, tiene custodia activa o
          recibió una solicitud de nuevo hogar de un titular.
        </p>
        {presentKinds.includes("rehome_request") && (
          // rehome-by-titular, REQ-11: the row's kind label alone reads like an
          // intake request. It is an accompaniment — said once, above the rows.
          <p className="text-sm text-ln-op-mute">
            Una solicitud de nuevo hogar es un acompañamiento: el animal vive con su familia y la
            organización publica la búsqueda y evalúa postulantes; no lo tiene en su poder.
          </p>
        )}
        {routedElsewhere.length > 0 && (
          <p className="text-sm text-ln-op-mute">
            {routedElsewhere.map((d, i) => (
              <span key={d.href}>
                {i > 0 ? " · " : ""}
                <Link href={d.href} className="underline hover:text-ln-op-ink">
                  {d.label}
                </Link>
              </span>
            ))}
            {" tienen su propia bandeja."}
          </p>
        )}
      </header>

      {/* Kind filter chips — only rendered when the org has more than one kind */}
      {presentKinds.length > 1 && (
        <nav aria-label="Filtros por tipo de caso" className="flex flex-wrap gap-2">
          <Link href={kindHref(null)} className={filterChipCls(activeKind === null)}>
            Todos los tipos
          </Link>
          {presentKinds.map((k) => (
            <Link key={k} href={kindHref(k)} className={filterChipCls(activeKind === k)}>
              {caseKindLabel(k)}
            </Link>
          ))}
        </nav>
      )}

      <Suspense>
        <CaseQueue
          rows={queueRows}
          filters={{ kind: activeKind, status: activeStatus }}
          filterBase={statusBase()}
          caption="Cola de casos de la organización"
          truncated={truncated}
          emptyMessage={emptyMessage}
        />
      </Suspense>
    </div>
  );
}

export const dynamic = "force-dynamic";
