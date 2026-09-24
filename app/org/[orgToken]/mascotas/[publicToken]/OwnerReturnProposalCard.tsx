"use client";

import { useState, useTransition } from "react";

import {
  orgAcceptOwnerReturnAction,
  orgRejectOwnerReturnAction,
} from "@/app/actions/return-to-owner";
import { OpButton, OpCard, OpCardBody, OpCardHead, OpTextarea } from "@/components/ui/dashboard";
import { notifySaved } from "@/lib/ui/action-feedback";

export function OwnerReturnProposalCard({
  orgToken,
  petPublicToken,
  petName,
  ownerDisplayName,
  proposedAt,
  proposalNotes,
}: {
  orgToken: string;
  petPublicToken: string;
  petName: string;
  ownerDisplayName: string | null;
  proposedAt: string;
  proposalNotes: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [doneMode, setDoneMode] = useState<"accept" | "reject" | null>(null);
  const [mode, setMode] = useState<"accept" | "reject" | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const formattedDate = new Date(proposedAt).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    // Fixed timeZone — server (UTC) and client (browser-local) must format
    // the same calendar day, otherwise dates near local midnight flip
    // between SSR and hydration (#418). Same pattern as
    // DashboardFreshnessFooter / OrgMascotasBulkList.tsx (de45cb85).
    timeZone: "America/Argentina/Buenos_Aires",
  });

  function handleAccept() {
    setError(null);
    startTransition(async () => {
      const result = await orgAcceptOwnerReturnAction({
        petPublicToken,
        orgToken,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setDoneMode("accept");
      setDone(true);
      // Tier B: the local `done` card is the terminal UI for this proposal;
      // the rest of the page re-derives on next SSR visit. router.refresh()
      // is banned (silent-drop defect — see lib/ui/full-page-action-nav.ts).
      // The toast is the confirmation (mutation-feedback convention).
      notifySaved("Devolución aceptada");
    });
  }

  function handleReject() {
    if (!rejectReason.trim()) {
      setError("Ingresá un motivo para el rechazo.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await orgRejectOwnerReturnAction({
        petPublicToken,
        orgToken,
        reason: rejectReason.trim(),
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setDoneMode("reject");
      setDone(true);
      // Tier B: same as accept — local done card is terminal.
      notifySaved("Propuesta rechazada");
    });
  }

  if (done) {
    return (
      <OpCard accent="warn">
        <OpCardHead title="Devolución propuesta" />
        <OpCardBody>
          <p className="text-sm text-ln-op-ok font-medium">
            {doneMode === "accept"
              ? "Devolución aceptada. La custodia fue transferida correctamente."
              : "Propuesta rechazada. El adoptante fue notificado."}
          </p>
        </OpCardBody>
      </OpCard>
    );
  }

  if (mode === "accept") {
    return (
      <OpCard accent="warn">
        <OpCardHead title="Aceptar la devolución" />
        <OpCardBody>
          <p className="text-md text-ln-op-ink mb-3">
            Aceptar la devolución de <strong>{petName}</strong> del adoptante{" "}
            <strong>{ownerDisplayName ?? "desconocido"}</strong>.
          </p>
          <p className="text-sm text-ln-op-mute mb-4">
            La custodia pasa a tu organización. El adoptante pierde el vínculo activo. Esta acción
            no se puede deshacer.
          </p>
          {error && <output className="block text-sm text-ln-op-danger mb-3">{error}</output>}
          <div className="flex gap-2">
            <OpButton type="button" variant="ok" onClick={handleAccept} disabled={pending}>
              {pending ? "Procesando..." : "Aceptar devolución"}
            </OpButton>
            <OpButton
              type="button"
              variant="ghost"
              onClick={() => {
                setMode(null);
                setError(null);
              }}
              disabled={pending}
            >
              Cancelar
            </OpButton>
          </div>
        </OpCardBody>
      </OpCard>
    );
  }

  if (mode === "reject") {
    return (
      <OpCard accent="warn">
        <OpCardHead title="Rechazar propuesta de devolución" />
        <OpCardBody>
          <p className="text-md text-ln-op-ink mb-3">
            Rechazar la devolución de <strong>{petName}</strong>.
          </p>
          <OpTextarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            placeholder="Motivo del rechazo (requerido)"
            className="mb-3"
          />
          {error && <output className="block text-sm text-ln-op-danger mb-3">{error}</output>}
          <div className="flex gap-2">
            <OpButton type="button" variant="danger" onClick={handleReject} disabled={pending}>
              {pending ? "Procesando..." : "Rechazar devolución"}
            </OpButton>
            <OpButton
              type="button"
              variant="ghost"
              onClick={() => {
                setMode(null);
                setError(null);
                setRejectReason("");
              }}
              disabled={pending}
            >
              Cancelar
            </OpButton>
          </div>
        </OpCardBody>
      </OpCard>
    );
  }

  return (
    <OpCard accent="warn">
      <OpCardHead title="Devolución propuesta por el adoptante" />
      <OpCardBody>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-md mb-4">
          <dt className="text-ln-op-mute">Adoptante</dt>
          <dd className="text-ln-op-ink">{ownerDisplayName ?? "—"}</dd>
          <dt className="text-ln-op-mute">Propuesta el</dt>
          <dd className="text-ln-op-ink">{formattedDate}</dd>
          {proposalNotes && (
            <>
              <dt className="text-ln-op-mute">Notas</dt>
              <dd className="text-ln-op-ink">{proposalNotes}</dd>
            </>
          )}
        </dl>
        <p className="text-sm text-ln-op-mute mb-4">
          El adoptante quiere devolver a <strong>{petName}</strong> a tu organización. Aceptá para
          tomar la custodia o rechazá con un motivo.
        </p>
        {error && <output className="block text-sm text-ln-op-danger mb-3">{error}</output>}
        <div className="flex flex-wrap gap-2">
          <OpButton type="button" size="sm" variant="ok" onClick={() => setMode("accept")}>
            Aceptar devolución
          </OpButton>
          <OpButton type="button" size="sm" variant="danger" onClick={() => setMode("reject")}>
            Rechazar
          </OpButton>
        </div>
      </OpCardBody>
    </OpCard>
  );
}
