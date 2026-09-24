"use client";

import { useRef, useState, useTransition } from "react";

import { lookupTransferTargetAction, resolveDisputeAction } from "@/app/actions/custody-disputes";
import { Icon } from "@/components/Icon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { OpButton, OpInput, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

// The consequence of an ownership_transferred resolution, stated once and used
// twice: as the inline hint under the destination field, and as the confirm
// dialog's description. Two copies would drift; one constant cannot.
const TRANSFER_CONSEQUENCE =
  "La transferencia cierra todas las ownerships activas y abre una nueva al destino.";

// Every resolution closes the dispute and lands an immutable event; only the
// ownership_transferred branch also moves custody, which is why that branch
// leads with TRANSFER_CONSEQUENCE.
const RESOLUTION_IS_FINAL =
  "La resolución se asienta como evento inmutable en el historial y no se puede deshacer.";

function resolveConsequence(outcome: Outcome): string {
  switch (outcome) {
    case "ownership_transferred":
      return `${TRANSFER_CONSEQUENCE} ${RESOLUTION_IS_FINAL}`;
    case "ownership_confirmed":
      return `Esto confirma al dueño actual y cierra la disputa. ${RESOLUTION_IS_FINAL}`;
    case "case_dismissed":
      return `Esto desestima el caso y cierra la disputa sin cambiar la titularidad. ${RESOLUTION_IS_FINAL}`;
    default:
      return `Esto cierra la disputa con la resolución que redactaste. ${RESOLUTION_IS_FINAL}`;
  }
}

const OUTCOMES = [
  { value: "ownership_confirmed", label: "Confirma al dueño actual" },
  { value: "ownership_transferred", label: "Transfiere a otra parte" },
  { value: "case_dismissed", label: "Caso desestimado" },
  { value: "other", label: "Otro" },
] as const;

type Outcome = (typeof OUTCOMES)[number]["value"];

type VerifyState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; displayName: string; active: boolean }
  | { status: "error"; message: string };

export function ResolveDisputeForm({ disputeToken }: { disputeToken: string }) {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<Outcome>("ownership_confirmed");
  const [transferKind, setTransferKind] = useState<"user" | "org">("user");
  const [transferToUserId, setTransferToUserId] = useState("");
  const [transferToOrgId, setTransferToOrgId] = useState("");
  const [verifyState, setVerifyState] = useState<VerifyState>({ status: "idle" });
  const [resolutionSummary, setResolutionSummary] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const resolveTriggerRef = useRef<HTMLButtonElement>(null);

  const currentTargetId = transferKind === "user" ? transferToUserId : transferToOrgId;

  function resetVerify() {
    setVerifyState({ status: "idle" });
  }

  function handleTargetChange(value: string) {
    if (transferKind === "user") setTransferToUserId(value);
    else setTransferToOrgId(value);
    resetVerify();
  }

  function handleKindChange(kind: "user" | "org") {
    setTransferKind(kind);
    resetVerify();
  }

  function verify() {
    const id = currentTargetId.trim();
    if (!id) return;
    setVerifyState({ status: "loading" });
    startTransition(async () => {
      const result = await lookupTransferTargetAction({ kind: transferKind, id, disputeToken });
      if (!result.found) {
        setVerifyState({ status: "error", message: result.error });
      } else {
        setVerifyState({ status: "ok", displayName: result.displayName, active: result.active });
      }
    });
  }

  // Step 1 of the resolve act: validate, then OPEN THE DIALOG. Resolving a
  // custody dispute is the gravest single click a government official makes in
  // this system — it closes every active ownership and opens a new one — and
  // until 2026-07-30 it fired straight off the button with no confirmation at
  // all (D.3, clase 1). The action itself only runs from `runResolve` below.
  function requestResolve() {
    setError(null);
    setOkMessage(null);
    if (resolutionSummary.trim().length < 100) {
      setError("El resumen tiene que tener al menos 100 caracteres.");
      return;
    }
    if (outcome === "ownership_transferred") {
      if (verifyState.status !== "ok") {
        setError("Verificá el destino de la transferencia antes de resolver.");
        return;
      }
      if (!verifyState.active) {
        setError("El destino está desactivado y no puede recibir la transferencia.");
        return;
      }
    }
    setConfirming(true);
  }

  // Step 2: the user confirmed in the dialog. This is the only caller of
  // resolveDisputeAction.
  function runResolve() {
    setError(null);
    startTransition(async () => {
      const result = await resolveDisputeAction({
        disputeToken,
        resolution: outcome,
        resolutionSummary,
        transferToUserId:
          outcome === "ownership_transferred" && transferKind === "user"
            ? transferToUserId.trim() || null
            : null,
        transferToOrgId:
          outcome === "ownership_transferred" && transferKind === "org"
            ? transferToOrgId.trim() || null
            : null,
        notes: notes.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      setOkMessage("Disputa resuelta.");
      // Full document reload so the SSR page reflects the mutation
      // (router.refresh() is banned - see lib/ui/full-page-action-nav.ts).
      navigateAfterActionSuccess(window.location.href);
    });
  }

  return (
    <div className="space-y-3 rounded-[var(--radius-md)] border border-ln-op-line p-4">
      <div>
        <label htmlFor="outcome" className="block text-sm text-ln-op-mute mb-1">
          Resolución
        </label>
        <OpSelect
          id="outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as Outcome)}
        >
          {OUTCOMES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </OpSelect>
      </div>

      {outcome === "ownership_transferred" && (
        <div className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-line p-3">
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => handleKindChange("user")}
              className={`px-2 py-1 rounded-[var(--radius-sm)] border ${
                transferKind === "user"
                  ? "bg-ln-op-azul text-white border-ln-op-azul"
                  : "border-ln-op-line text-ln-op-ink hover:bg-ln-op-stripe"
              }`}
            >
              A persona
            </button>
            <button
              type="button"
              onClick={() => handleKindChange("org")}
              className={`px-2 py-1 rounded-[var(--radius-sm)] border ${
                transferKind === "org"
                  ? "bg-ln-op-azul text-white border-ln-op-azul"
                  : "border-ln-op-line text-ln-op-ink hover:bg-ln-op-stripe"
              }`}
            >
              A organización
            </button>
          </div>
          <div>
            <label htmlFor="transfer-target" className="block text-sm text-ln-op-mute mb-1">
              {transferKind === "user"
                ? "ID de usuario destino (UUID)"
                : "ID de organización destino (UUID)"}
            </label>
            <div className="flex gap-2">
              <OpInput
                id="transfer-target"
                type="text"
                value={currentTargetId}
                onChange={(e) => handleTargetChange(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                className="flex-1 font-ln-mono"
                block={false}
              />
              <OpButton
                type="button"
                onClick={verify}
                disabled={pending || !currentTargetId.trim()}
                variant="ghost"
                className="px-3 py-2 whitespace-nowrap"
              >
                {verifyState.status === "loading" ? "Verificando..." : "Verificar"}
              </OpButton>
            </div>

            {verifyState.status === "ok" && (
              <p
                className={`text-sm mt-1 flex items-center gap-1 ${verifyState.active ? "text-ln-op-ok" : "text-ln-op-danger"}`}
              >
                <Icon name={verifyState.active ? "check" : "close"} size={14} decorative />
                <span>
                  {verifyState.displayName}
                  {!verifyState.active && " — cuenta desactivada"}
                </span>
              </p>
            )}
            {verifyState.status === "error" && (
              <p className="text-sm text-ln-op-danger mt-1">{verifyState.message}</p>
            )}

            <p className="text-sm text-ln-op-mute mt-1">{TRANSFER_CONSEQUENCE}</p>
          </div>
        </div>
      )}

      <div>
        <label htmlFor="resolution-summary" className="block text-sm text-ln-op-mute mb-1">
          Resumen de la resolución (mínimo 100 caracteres)
        </label>
        <OpTextarea
          id="resolution-summary"
          value={resolutionSummary}
          onChange={(e) => setResolutionSummary(e.target.value)}
          rows={5}
          placeholder="Explicá el fundamento, evidencia considerada y decisión tomada."
        />
        <p className="text-sm text-ln-op-mute mt-1 tabular-nums">
          {resolutionSummary.trim().length} / 100
        </p>
      </div>

      <div>
        <label htmlFor="resolution-notes" className="block text-sm text-ln-op-mute mb-1">
          Notas internas (opcional)
        </label>
        <OpTextarea
          id="resolution-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Notas que quedan en el payload del evento"
        />
      </div>

      {error && <output className="block text-md text-ln-op-danger">{error}</output>}
      {okMessage && <output className="block text-md text-ln-op-ok">{okMessage}</output>}

      <div className="flex gap-2">
        <OpButton
          ref={resolveTriggerRef}
          type="button"
          onClick={requestResolve}
          disabled={pending}
          variant="primary"
          className="px-4 py-2"
        >
          {pending ? "Resolviendo..." : "Resolver disputa"}
        </OpButton>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => !pending && setConfirming(false)}
        onConfirm={runResolve}
        title="Resolver la disputa de custodia"
        description={resolveConsequence(outcome)}
        confirmLabel="Resolver disputa"
        tone="danger"
        pending={pending}
        triggerRef={resolveTriggerRef}
      />
    </div>
  );
}
