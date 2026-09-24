"use client";

import { useState, useTransition } from "react";

import {
  approveRequestAction,
  rejectRequestAction,
  requestInfoAction,
} from "@/app/actions/admin-decisions";
import { LnCheckbox } from "@/components/ui/Field";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

import {
  MATRICULA_VERIFICATION_CHECKLIST,
  type MatriculaChecklistKey,
  composeMatriculaApprovalNotes,
} from "../_lib/matricula-verification";

type Mode = "idle" | "approving" | "rejecting" | "info";

export function ReviewActions({
  publicToken,
  requestType,
}: {
  publicToken: string;
  /** approval_requests.type — drives the matrícula verification checklist. */
  requestType: string;
}) {
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<Mode>("idle");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [infoSent, setInfoSent] = useState(false);
  const [checked, setChecked] = useState<Set<MatriculaChecklistKey>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Matrícula approvals are a VERIFICATION flow (UI/UX audit 2026-07): the
  // approver must tick the checklist (format / official registry / identity)
  // before the approve button unlocks; the ticks persist as a structured
  // prefix in the decision notes (see composeMatriculaApprovalNotes).
  const isVetMatricula = requestType === "role_upgrade_vet";
  const checklistComplete =
    !isVetMatricula || MATRICULA_VERIFICATION_CHECKLIST.every((c) => checked.has(c.key));

  function toggleCheck(key: MatriculaChecklistKey) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function resetTo(nextMode: Mode) {
    setMode(nextMode);
    setNotes("");
    setReason("");
    setInfoMessage("");
    setChecked(new Set());
    setError(null);
  }

  function approve() {
    setError(null);
    startTransition(async () => {
      const persistedNotes = isVetMatricula
        ? composeMatriculaApprovalNotes(notes)
        : notes.trim() || null;
      const result = await approveRequestAction(publicToken, persistedNotes);
      if ("error" in result) setError(result.error);
      else {
        resetTo("idle");
        // Full document reload so the SSR page reflects the mutation
        // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
        navigateAfterActionSuccess(window.location.href);
      }
    });
  }

  function reject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectRequestAction(publicToken, reason);
      if ("error" in result) setError(result.error);
      else {
        resetTo("idle");
        // Full document reload so the SSR page reflects the mutation
        // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
        navigateAfterActionSuccess(window.location.href);
      }
    });
  }

  function requestInfo() {
    setError(null);
    startTransition(async () => {
      const result = await requestInfoAction(publicToken, infoMessage);
      if ("error" in result) setError(result.error);
      else {
        // NON-terminal: the request stays pending — no navigation, just an
        // inline confirmation so the operator sees the message went out.
        resetTo("idle");
        setInfoSent(true);
      }
    });
  }

  if (mode === "approving") {
    return (
      <div className="space-y-3">
        {isVetMatricula && (
          <fieldset className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-line px-3 py-2.5">
            <legend className="px-1 text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
              Verificación obligatoria
            </legend>
            {MATRICULA_VERIFICATION_CHECKLIST.map((item) => (
              <LnCheckbox
                key={item.key}
                id={`check-${item.key}`}
                checked={checked.has(item.key)}
                onChange={() => toggleCheck(item.key)}
              >
                {item.label}
              </LnCheckbox>
            ))}
            {!checklistComplete && (
              <p className="text-sm text-ln-op-mute">
                Marcá los tres puntos para habilitar la aprobación.
              </p>
            )}
          </fieldset>
        )}
        <OpTextarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notas para el aplicante (opcional)."
          rows={2}
          size="sm"
        />
        <div className="flex items-center gap-2">
          <OpButton
            type="button"
            onClick={approve}
            disabled={pending || !checklistComplete}
            variant="ok"
            size="sm"
          >
            {pending ? "Aprobando..." : "Aprobar solicitud"}
          </OpButton>
          <OpButton type="button" onClick={() => resetTo("idle")} variant="ghost" size="sm">
            Cancelar
          </OpButton>
        </div>
        {error && <p className="text-sm text-ln-op-danger">{error}</p>}
      </div>
    );
  }

  if (mode === "rejecting") {
    const tooShort = reason.trim().length < 5;
    return (
      <div className="space-y-2">
        <OpTextarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Razón del rechazo (mínimo 5 caracteres). Se envía al aplicante."
          rows={3}
          size="sm"
        />
        <div className="flex items-center gap-2">
          <OpButton
            type="button"
            onClick={reject}
            disabled={pending || tooShort}
            variant="danger"
            size="sm"
          >
            {pending ? "Rechazando..." : "Rechazar solicitud"}
          </OpButton>
          <OpButton type="button" onClick={() => resetTo("idle")} variant="ghost" size="sm">
            Cancelar
          </OpButton>
        </div>
        {error && <p className="text-sm text-ln-op-danger">{error}</p>}
      </div>
    );
  }

  if (mode === "info") {
    const tooShort = infoMessage.trim().length < 5;
    return (
      <div className="space-y-2">
        <OpTextarea
          value={infoMessage}
          onChange={(e) => setInfoMessage(e.target.value)}
          placeholder="Qué información falta (mínimo 5 caracteres). Se envía al aplicante; la solicitud sigue pendiente."
          rows={3}
          size="sm"
        />
        <div className="flex items-center gap-2">
          <OpButton
            type="button"
            onClick={requestInfo}
            disabled={pending || tooShort}
            variant="primary"
            size="sm"
          >
            {pending ? "Enviando..." : "Enviar pedido"}
          </OpButton>
          <OpButton type="button" onClick={() => resetTo("idle")} variant="ghost" size="sm">
            Cancelar
          </OpButton>
        </div>
        {error && <p className="text-sm text-ln-op-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <OpButton
          type="button"
          onClick={() => setMode("approving")}
          disabled={pending}
          variant="ok"
        >
          Aprobar
        </OpButton>
        <OpButton
          type="button"
          onClick={() => setMode("rejecting")}
          disabled={pending}
          variant="danger"
        >
          Rechazar
        </OpButton>
        <OpButton type="button" onClick={() => setMode("info")} disabled={pending} variant="ghost">
          Pedir más información
        </OpButton>
      </div>
      {infoSent && (
        <output className="block text-sm text-ln-op-mute">
          Pedido de información enviado. La solicitud sigue pendiente.
        </output>
      )}
      {error && <p className="text-sm text-ln-op-danger">{error}</p>}
    </div>
  );
}
