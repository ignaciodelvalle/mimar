// Pet transfer detail / accept-reject page (handoff P3-2).
// Presentation redesign only — data fetching and AcceptTransferActions unchanged.

import Link from "next/link";

import { LnCard, LnCardBody, LnCardHead } from "@/components/ui/Card";
import { LnCallout } from "@/components/ui/DocElements";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { formatDateTime } from "@/lib/utils/format";
import { getTransferForViewerAction as getTransferForViewer } from "@/src/modules/transfers/actions";
import { AcceptTransferActions } from "./AcceptTransferActions";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  accepted: "Aceptada",
  rejected: "Rechazada",
  expired: "Expirada",
  cancelled: "Cancelada",
};

const REASON_LABELS: Record<string, string> = {
  sale: "Venta",
  gift: "Regalo",
  inheritance: "Herencia",
  other: "Otro",
};

export default async function TransferPage({
  params,
}: {
  params: Promise<{ transferToken: string }>;
}) {
  await requireUserOrRedirect();
  const { transferToken } = await params;
  const result = await getTransferForViewer(transferToken);

  if (!result.ok) {
    return (
      <div className="mx-auto max-w-md px-8 py-7 pb-12">
        <Link
          href="/transferencias"
          className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
        >
          ← Transferencias
        </Link>
        <LnCallout tone="warn" title="No se pudo cargar la transferencia">
          {result.error}
        </LnCallout>
      </div>
    );
  }

  const { transfer } = result;
  const statusLabel = STATUS_LABELS[transfer.status] ?? transfer.status;
  const reasonLabel = transfer.reason ? (REASON_LABELS[transfer.reason] ?? transfer.reason) : null;

  const statusBadgeClass =
    transfer.status === "accepted"
      ? "border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]"
      : transfer.status === "pending"
        ? "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]"
        : "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]";

  return (
    <div className="mx-auto max-w-md px-8 py-7 pb-12">
      {/* Back */}
      <Link
        href="/transferencias"
        className="mb-5 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-azul)] no-underline hover:underline"
      >
        ← Transferencias
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="m-0 font-ln-serif text-2xl font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-ink)]">
            {transfer.isRecipient
              ? `Recibiste a ${transfer.petName}`
              : `Transferencia de ${transfer.petName}`}
          </h1>
          {transfer.fromDisplayName && transfer.isRecipient && (
            <p className="mt-1 text-md text-[var(--color-ln-mute)]">
              {transfer.fromDisplayName} te quiere transferir esta mascota.
            </p>
          )}
        </div>
        <span
          className={`flex-shrink-0 inline-flex items-center rounded-[var(--radius-xs)] border px-2 py-0.5 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] ${statusBadgeClass}`}
        >
          {statusLabel}
        </span>
      </div>

      {/* Details */}
      <LnCard className="mb-5">
        <LnCardHead title="Detalle de la transferencia" />
        <LnCardBody>
          <dl className="flex flex-col gap-3">
            {reasonLabel && <DetailRow label="Motivo">{reasonLabel}</DetailRow>}
            {transfer.note && <DetailRow label="Comentario">{transfer.note}</DetailRow>}
            <DetailRow label="Vence">{formatDateTime(transfer.expiresAt)}</DetailRow>
            <DetailRow label="Email del receptor">
              <span className="font-ln-mono text-md">{transfer.toEmail}</span>
            </DetailRow>
          </dl>
        </LnCardBody>
      </LnCard>

      {/* Actions — rendered unconditionally so the accept receipt survives the
          action's RSC refresh; the component itself renders nothing once the
          transfer is no longer pending (see its header). */}
      <AcceptTransferActions
        transferToken={transfer.publicToken}
        isPending={transfer.status === "pending"}
        isRecipient={transfer.isRecipient}
        isSender={transfer.isSender}
        petToken={transfer.petToken}
        petName={transfer.petName}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-ln-mono text-xs uppercase tracking-[.08em] text-[var(--color-ln-mute)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-md text-[var(--color-ln-ink-2)]">{children}</dd>
    </div>
  );
}
