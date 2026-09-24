// Sender-side outgoing transfers list. Shows every
// custody_transfer_handshake case the org opened — open + closed.

// ---------------------------------------------------------------------------
// WIRED (sprint 5 PR-047 — 2026-05-27)
//
// Reachable from the org dashboard "Transferencias pendientes" count card.
// Sender flow itself is wired by PR-033 (ProposeTransferForm as wizard).
// ---------------------------------------------------------------------------

import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";

import { LnEmptyState } from "@/components/ui/EmptyState";
import { ResultCount } from "@/components/ui/ResultCount";
import { OpCard, OpCardBody, OpCrumbs, OpPill } from "@/components/ui/dashboard";
import { cases, db, pets } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { formatDate, requestOutcomeLabel } from "@/lib/utils/format";
import { capRows } from "@/lib/utils/list-pagination";
import { CancelTransferAction } from "./CancelTransferAction";

// "open" comes from requestOutcomeLabel — shared with the receiver's
// Transferencias recibidas screen so the same case status never reads two
// different words across the org's own two tabs (copy audit 2026-08-04).
const STATUS_LABEL: Record<string, string> = {
  open: requestOutcomeLabel("open") ?? "Pendiente",
  escalated: "Escalada",
  closed: "Cerrada",
  merged: "Fusionada",
};

// "Rechazada / Cancelada", no "Cancelada" a secas (2026-08-18).
//
// `cases.closedReason` guarda el MISMO valor `cancelled` en los dos casos:
// cuando la organización receptora rechaza (reject-cross-org-transfer.ts) y
// cuando la emisora cancela (cancel-cross-org-transfer.ts). La base no distingue
// quién actuó, así que esta pantalla no puede saberlo — y decir "Cancelada" a
// secas afirmaba lo que no sabe: la organización que propuso la transferencia y
// fue RECHAZADA leía en su propia lista de salientes que la había cancelado
// ella, con lo cual la negativa de la otra parte desaparecía de la vista.
//
// La pantalla hermana de entrantes ya usaba el hedge honesto; esta era la que
// faltaba. La nota del timeline del caso sí distingue ("Rechazada por el
// receptor" vs "Cancelada por el sender"), así que el dato existe para quien
// abre el detalle — lo que faltaba era no mentir en la lista.
//
// El arreglo de fondo es que los dos escritores dejen de compartir el mismo
// `closedReason`, y eso es una migración: queda anotado, no se hace acá.
const CLOSED_REASON_LABEL: Record<string, string> = {
  resolved: "Aceptada",
  cancelled: "Rechazada / Cancelada",
  auto_expired: "Expirada (30d sin respuesta)",
  merged: "Fusionada",
};

const STATUS_PILL_TONE: Record<string, "ok" | "open" | "danger" | "neutral" | "escalated"> = {
  open: "open",
  escalated: "escalated",
  closed: "neutral",
  merged: "neutral",
};

export default async function OrgTransferenciasSalientesPage({
  params,
}: {
  params: Promise<{ orgToken: string }>;
}) {
  const { orgToken } = await params;
  const { organization } = await requireOrgAccessByToken(orgToken);

  const rows = await db
    .select({
      caseId: cases.id,
      publicCode: cases.publicCode,
      status: cases.status,
      closedReason: cases.closedReason,
      openedAt: cases.openedAt,
      closedAt: cases.closedAt,
      petName: pets.name,
      petPublicToken: pets.publicToken,
    })
    .from(cases)
    // Art. 16: the CASE is the org's own record and stays listed; the erased
    // pet's name goes dark (the left join yields null → "(sin pet)"). Filter
    // in the join, not the where, so the case row itself survives.
    .leftJoin(pets, and(eq(pets.id, cases.primaryPetId), isNull(pets.deletedAt)))
    .where(
      and(
        eq(cases.openedByOrganizationId, organization.id),
        eq(cases.caseKind, "custody_transfer_handshake"),
      ),
    )
    .orderBy(desc(cases.openedAt))
    // UX 3.6 (d) / #815 audit finding #7: fetch one extra row past the cap to
    // detect truncation (same pattern as adopciones/page.tsx), instead of a
    // bare limit(200) that silently drops older rows with no indication.
    .limit(201);

  const { rows: handshakeRows, truncated } = capRows(rows, 200);

  return (
    <div className="space-y-6">
      <OpCrumbs
        items={[
          { label: "Panel", href: `/org/${orgToken}` },
          { label: "Transferencias salientes" },
        ]}
      />

      <header className="flex items-baseline justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-title font-semibold text-ln-op-ink">Transferencias salientes</h1>
          <p className="text-md text-ln-op-mute">
            Propuestas que {organization.displayName} envió a otras organizaciones.
          </p>
        </div>
        <Link
          href={`/org/${orgToken}/transferencias/nueva`}
          className="inline-flex items-center rounded-[var(--radius-md)] bg-ln-op-azul px-3 py-1.5 text-md font-medium text-white hover:opacity-90 transition-opacity no-underline"
        >
          + Nueva propuesta
        </Link>
      </header>

      <nav className="flex gap-4 text-sm">
        <span className="font-semibold text-ln-op-ink">Salientes</span>
        <Link
          href={`/org/${orgToken}/transferencias/recibidas`}
          className="text-ln-op-azul hover:underline no-underline"
        >
          Entrantes →
        </Link>
      </nav>

      {handshakeRows.length === 0 ? (
        <LnEmptyState icon="transferencia" title="Todavía no propusiste ninguna transferencia." />
      ) : (
        <>
          <OpCard>
            <OpCardBody className="p-0">
              <ul className="divide-y divide-ln-op-line">
                {handshakeRows.map((r) => {
                  const statusLabel =
                    r.status === "closed" && r.closedReason
                      ? (CLOSED_REASON_LABEL[r.closedReason] ?? STATUS_LABEL[r.status])
                      : (STATUS_LABEL[r.status] ?? r.status);
                  return (
                    <li key={r.caseId} className="px-4 py-3 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <p className="text-md font-medium text-ln-op-ink">
                            {r.petName ?? "(sin pet)"}{" "}
                            <span className="font-ln-mono text-sm text-ln-op-mute">
                              · {r.publicCode}
                            </span>
                          </p>
                          <p className="text-sm text-ln-op-mute">
                            Abierta el {formatDate(r.openedAt)}
                            {r.closedAt ? ` · Cerrada el ${formatDate(r.closedAt)}` : ""}
                          </p>
                          <Link
                            href={`/casos/${r.publicCode}`}
                            className="inline-block text-sm text-ln-op-azul hover:underline no-underline"
                          >
                            Ver caso →
                          </Link>
                        </div>
                        <OpPill tone={STATUS_PILL_TONE[r.status] ?? "neutral"}>
                          {statusLabel}
                        </OpPill>
                      </div>
                      {/* Cancel — sender side only, only while the proposal is
                          still pending (E4, 2026-07-21 facades harvest). */}
                      {r.status === "open" && (
                        <CancelTransferAction
                          senderOrgToken={orgToken}
                          casePublicCode={r.publicCode}
                          petName={r.petName ?? "(sin pet)"}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </OpCardBody>
          </OpCard>
          {truncated && (
            <ResultCount
              shown={200}
              noun="transferencias"
              hint="Este listado todavía no tiene filtros."
              className="text-sm text-ln-op-mute"
            />
          )}
        </>
      )}
    </div>
  );
}
