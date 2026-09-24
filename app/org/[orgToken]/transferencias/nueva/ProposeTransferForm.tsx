"use client";

// ProposeTransferForm — 3-step wizard for cross-org transfer (spec §5.2).
// Trilogy unification handoff §4 PR-033.
//
// Steps:
//   1. Mascota — recap of which pet is being transferred (read-only).
//      CTA Continuar.
//   2. Destino — org dropdown (pre-filtered to verified orgs). CTA Continuar.
//   3. Razón + notas — reason enum + free-text. CTA Confirmar transferencia.
//
// Cierre: SuccessScreen "Handshake abierto. Esperando respuesta de [org]"
// per handoff §4 — replaces the previous router.push redirect.

import { useState, useTransition } from "react";

import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { OpButton, OpTextarea } from "@/components/ui/dashboard";
import { proposeCrossOrgTransferAction } from "@/src/modules/transfers/actions";

interface ReceiverOption {
  id: string;
  displayName: string;
  jurisdiction: string;
  orgType: string;
}

const REASON_OPTIONS = [
  { value: "space_constraint", label: "Falta de espacio" },
  { value: "specialization_needed", label: "Especialización requerida" },
  { value: "network_redistribution", label: "Redistribución en network" },
  { value: "shelter_closing", label: "Cierre operativo del refugio" },
  { value: "post_adoption_failed_return", label: "Devolución post-adopción fallida" },
  { value: "other", label: "Otro motivo (describí abajo)" },
] as const;

const ORG_TYPE_LABEL: Record<string, string> = {
  shelter: "Refugio",
  rescue_network: "Red de rescate",
  clinic: "Clínica",
  sanitary_authority: "Autoridad sanitaria",
};

interface Props {
  senderOrgToken: string;
  petPublicToken: string;
  petName: string;
  receivers: ReceiverOption[];
}

const TOTAL_STEPS = 3;
const STEP_LABELS = ["Mascota", "Destino", "Razón y notas"];

const selectCls =
  "w-full rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 text-md text-ln-op-ink focus:outline-none focus:ring-1 focus:ring-ln-op-azul";

export function ProposeTransferForm({ senderOrgToken, petPublicToken, petName, receivers }: Props) {
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState(1);
  const [receiverOrgId, setReceiverOrgId] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const reasonRequiresNotes = reason === "other";
  const canSubmit =
    !!receiverOrgId && !!reason && (!reasonRequiresNotes || notes.trim().length > 0) && !pending;
  const selectedReceiver = receivers.find((r) => r.id === receiverOrgId);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await proposeCrossOrgTransferAction({
        senderOrgToken,
        petPublicToken,
        receiverOrgId,
        reason,
        notes: notes.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSubmitted(true);
    });
  }

  if (submitted) {
    return (
      <LnSuccessScreen
        title={`Handshake abierto para ${petName}`}
        description={
          selectedReceiver
            ? `Esperando respuesta de ${selectedReceiver.displayName}. ${petName} sigue bajo tu custodia hasta que acepten.`
            : `Esperando respuesta del destinatario. ${petName} sigue bajo tu custodia hasta que acepten.`
        }
        next={[
          { label: "Ver transferencias", href: `/org/${senderOrgToken}/transferencias` },
          {
            label: `Volver a la ficha de ${petName}`,
            href: `/org/${senderOrgToken}/mascotas/${petPublicToken}`,
            variant: "secondary",
          },
        ]}
      />
    );
  }

  return (
    <LnWizardShell
      currentStep={step}
      totalSteps={TOTAL_STEPS}
      stepLabels={STEP_LABELS}
      onBack={step > 1 ? () => setStep((s) => s - 1) : undefined}
    >
      {/* Step 1 — Mascota recap */}
      <section
        className={step === 1 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 1}
        inert={step !== 1 ? true : undefined}
      >
        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe p-4">
          <p className="text-sm uppercase tracking-wider text-ln-op-mute">Vas a transferir</p>
          <p className="mt-1 text-base font-semibold text-ln-op-ink">{petName}</p>
          <p className="mt-2 text-sm text-ln-op-mute">
            Token: <span className="font-ln-mono">{petPublicToken}</span>
          </p>
        </div>
        <p className="text-md text-ln-op-ink-2">
          Esta propuesta crea un handshake con otra organización. La transferencia se concreta solo
          si el destinatario acepta.
        </p>
        <OpButton type="button" onClick={() => setStep(2)} block>
          Continuar
        </OpButton>
      </section>

      {/* Step 2 — Destino */}
      <section
        className={step === 2 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 2}
        inert={step !== 2 ? true : undefined}
      >
        <div>
          <label htmlFor="receiverOrgId" className="mb-1 block text-md font-medium text-ln-op-ink">
            Organización destinataria
          </label>
          <select
            id="receiverOrgId"
            value={receiverOrgId}
            onChange={(e) => setReceiverOrgId(e.target.value)}
            required
            className={selectCls}
          >
            <option value="">Elegí una organización verificada…</option>
            {receivers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName} · {ORG_TYPE_LABEL[r.orgType] ?? r.orgType}
                {r.jurisdiction ? ` · ${r.jurisdiction}` : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-sm text-ln-op-mute">
            Solo aparecen orgs verificadas activas. Sin auto-selección por proximidad.
          </p>
        </div>
        <OpButton type="button" onClick={() => setStep(3)} disabled={!receiverOrgId} block>
          Continuar
        </OpButton>
      </section>

      {/* Step 3 — Razón + notas */}
      <section
        className={step === 3 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 3}
        inert={step !== 3 ? true : undefined}
      >
        <div>
          <label htmlFor="reason" className="mb-1 block text-md font-medium text-ln-op-ink">
            Motivo de la transferencia
          </label>
          <select
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            className={selectCls}
          >
            <option value="">Elegí un motivo…</option>
            {REASON_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="notes" className="mb-1 block text-md font-medium text-ln-op-ink">
            Notas{reasonRequiresNotes ? " (obligatorias)" : " (opcional)"}
          </label>
          <OpTextarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            required={reasonRequiresNotes}
            placeholder="Contexto para que el destinatario evalúe — visible al receiver."
          />
        </div>

        <div className="rounded-[var(--radius-md)] border border-ln-op-warn bg-ln-op-warn/10 p-3 text-sm text-ln-op-ink-2">
          <p>
            La propuesta expira en <strong>30 días</strong> si no recibe respuesta del destinatario.{" "}
            {petName} sigue bajo tu custodia hasta que la organización destinataria acepte.
          </p>
        </div>

        {error && (
          <p className="rounded-[var(--radius-md)] border border-ln-op-danger bg-ln-op-danger/10 p-3 text-md text-ln-op-danger">
            {error}
          </p>
        )}

        <OpButton type="button" onClick={submit} disabled={!canSubmit} block>
          {pending ? "Enviando…" : "Confirmar transferencia"}
        </OpButton>
      </section>
    </LnWizardShell>
  );
}
