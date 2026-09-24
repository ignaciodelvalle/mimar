import { newerHref, olderHref } from "@/lib/utils/keyset-pagination";
import { inArray } from "drizzle-orm";
import Link from "next/link";

import { BulkApprovalQueueList } from "@/components/BulkApprovalQueueList";
import { ScreenHeader } from "@/components/ui/dashboard/ScreenHeader";
import { APPROVAL_REQUEST_TYPES, type ApprovalRequestType, db, profiles } from "@/db";
import { fetchVisiblePendingRequests } from "@/lib/infra/approval-scope";
import { requireGobReadAccessOrRedirect } from "@/lib/infra/auth-guards";
import { recordSurfaceVisit } from "@/lib/infra/surface-visits";
import { portalBase } from "@/lib/ui/portal-base";
import { pluralizeEs } from "@/lib/utils/format";

const TYPE_LABELS: Record<ApprovalRequestType, string> = {
  role_upgrade_vet: "Matrículas veterinarias",
  organization_verification: "Verificación de organizaciones",
  service_dog_credential_verification: "Credenciales de perro de asistencia (RUPGA)",
};

// Validate a raw searchParam value against the known enum.
function parseTypeParam(raw: string | undefined): ApprovalRequestType | null {
  if (!raw) return null;
  return (APPROVAL_REQUEST_TYPES as readonly string[]).includes(raw)
    ? (raw as ApprovalRequestType)
    : null;
}

const COLA_PAGE_LIMIT = 200;

export default async function ColaPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; cursor?: string }>;
}) {
  const { user, profile, jurisdictions } = await requireGobReadAccessOrRedirect();
  const base = await portalBase();

  // T4-O3 (gob-onboarding-checklist, "approvals" step) — record the visit.
  // Best-effort, never blocks/fails this render (lib/infra/surface-visits.ts).
  await recordSurfaceVisit(user.id, "cola");

  const { type: rawType, cursor: rawCursor } = await searchParams;
  const activeType = parseTypeParam(rawType);

  // Fetch limit+1 to detect hasMore for keyset pagination (PERF-5).
  const rawPending = await fetchVisiblePendingRequests(
    profile,
    jurisdictions,
    activeType ?? undefined,
    { limit: COLA_PAGE_LIMIT + 1, cursor: rawCursor },
  );

  const hasMore = rawPending.length > COLA_PAGE_LIMIT;
  const pending = hasMore ? rawPending.slice(0, COLA_PAGE_LIMIT) : rawPending;

  // Resolve applicant display names in one batched query so the list
  // renders human-readable instead of UUIDs.
  const applicantIds = Array.from(new Set(pending.map((r) => r.applicantUserId)));
  const namesById = new Map<string, string>();
  if (applicantIds.length > 0) {
    const rows = await db
      .select({ id: profiles.id, displayName: profiles.displayName })
      .from(profiles)
      .where(inArray(profiles.id, applicantIds));
    for (const r of rows) namesById.set(r.id, r.displayName);
  }

  // Title renamed from "Cola de solicitudes" / "Cola — {tipo}" (PO interview
  // 2026-07-23, item 5): the nav rename ("Cola" → "Aprobaciones") must stay
  // coherent with the page it points to.
  const pageTitle = activeType ? `Aprobaciones — ${TYPE_LABELS[activeType]}` : "Aprobaciones";

  // Empty case no longer duplicates a one-line "no hay…" sentence here — the
  // single LnEmptyState rendered by BulkApprovalQueueList (below) already
  // carries that message with an icon/title/description, so the header stays
  // silent instead of repeating it.
  const subtitle =
    pending.length > 0
      ? `${pending.length}${hasMore ? "+" : ""} ${pluralizeEs(pending.length, "solicitud")} ${pluralizeEs(pending.length, "pendiente")}.`
      : null;

  // Pagination links — filter params exclude cursor so changing a filter resets to page 1.
  const filterParams: Record<string, string | undefined> = activeType ? { type: activeType } : {};
  const lastReq = pending.at(-1);
  const olderLink =
    hasMore && lastReq
      ? olderHref(`${base}/cola`, filterParams, { ts: lastReq.createdAt, id: lastReq.id })
      : null;
  const newerLink = rawCursor ? newerHref(`${base}/cola`, filterParams) : null;

  return (
    <div className="space-y-6">
      <ScreenHeader
        className="space-y-2"
        title={pageTitle}
        subtitle={subtitle ? <p className="text-md text-ln-op-mute">{subtitle}</p> : undefined}
      />

      {/*
       * Type filter chips — links drop ?cursor so filters reset to page 1.
       *
       * NOTE on component choice: `OpPill` (components/ui/dashboard/OpPill.tsx)
       * is a read-only STATUS/tone badge (open|escalated|closed|ok|…) — it has
       * no Link/active-state API and is used exactly that way everywhere else
       * in the codebase (see app/gob/cola/[publicToken]/page.tsx's status
       * pill). Wrapping it as a clickable nav filter would be a misuse of its
       * contract, not a kit migration. The kit's own `CaseQueue` component
       * (components/ui/dashboard/CaseQueue.tsx:182-204) faces the identical
       * problem — a URL-driven filter Link with an active/inactive style —
       * and hand-rolls the SAME pattern rather than delegating to OpPill.
       * That inline pattern (Link + aria-pressed + border/bg swap) is the
       * closest thing this codebase has to a "canonical" filter chip, so
       * these chips are aligned to CaseQueue's exact classes (added
       * aria-pressed, matching hover:bg-ln-op-stripe) instead of forcing a
       * status-badge component into a navigation role.
       */}
      <nav aria-label="Filtrar por tipo" className="flex flex-wrap gap-2">
        <Link
          href={`${base}/cola`}
          aria-pressed={!activeType}
          className={[
            "inline-flex items-center rounded-full border px-3.5 py-1 text-sm font-medium no-underline transition-colors",
            !activeType
              ? "border-ln-op-azul bg-ln-op-azul text-white"
              : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe",
          ].join(" ")}
        >
          Todas
        </Link>
        {(APPROVAL_REQUEST_TYPES as readonly ApprovalRequestType[]).map((t) => (
          <Link
            key={t}
            href={`${base}/cola?type=${t}`}
            aria-pressed={activeType === t}
            className={[
              "inline-flex items-center rounded-full border px-3.5 py-1 text-sm font-medium no-underline transition-colors",
              activeType === t
                ? "border-ln-op-azul bg-ln-op-azul text-white"
                : "border-ln-op-line bg-ln-op-card text-ln-op-ink-2 hover:bg-ln-op-stripe",
            ].join(" ")}
          >
            {TYPE_LABELS[t]}
          </Link>
        ))}
      </nav>

      <BulkApprovalQueueList
        detailUrlPrefix={`${base}/cola`}
        historyHref={`${base}/historial`}
        // The fourth kind of approval work, which this queue cannot hold:
        // service offerings are not approval_requests (see TYPE_LABELS above).
        servicesHref={`${base}/directorio?registro=servicios`}
        items={pending.map((req) => ({
          publicToken: req.publicToken,
          type: req.type,
          typeLabel: TYPE_LABELS[req.type] ?? req.type,
          applicantName: namesById.get(req.applicantUserId) ?? "Usuario",
          jurisdiction: `${req.jurisdictionLocality}, ${req.jurisdictionProvince}`,
          // RAW ISO timestamp — the row formats it with the shared `formatDate`
          // (queue-anatomy alignment, 2026-07-30). Pre-formatting here is what
          // let this queue drift to its own `formatDateShort` vocabulary.
          createdAt: req.createdAt.toISOString(),
        }))}
      />

      {/* Pagination footer */}
      {(newerLink || olderLink) && (
        <nav
          aria-label="Paginación de aprobaciones"
          className="flex items-center justify-between gap-4 border-t border-ln-op-line pt-4"
        >
          <div>
            {newerLink && (
              <Link
                href={newerLink}
                className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
              >
                ← Más recientes
              </Link>
            )}
          </div>
          <div>
            {olderLink && (
              <Link
                href={olderLink}
                className="text-sm font-medium text-ln-op-azul no-underline hover:underline"
              >
                Ver más antiguos →
              </Link>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}
