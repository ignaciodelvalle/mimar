"use client";

// Outreach "Enviar recordatorio(s)" list — the interactive companion to the
// overdue-antirrábica pipeline card on /gob/operativos?vista=alcance
// (sweep-fixes-2 2026-07-23, PO-approved). Renders the SAME rows the server
// component used to render inline (moved here so the per-row "Recordar"
// button and the bulk "Enviar recordatorios (N)" button can share local
// state), plus the two write actions.
//
// The operator never sees owner contact data — every action here only ever
// carries a petId; lib/infra/outreach-reminders.ts resolves the owner
// internally and re-validates jurisdiction scope server-side.
//
// Feedback convention (lib/ui/action-feedback.ts §C1): per-row send is an
// in-place mutation (no reload) → notifySaved toast + an inline outcome
// string replacing the button, mirroring VerifyOrgButton.tsx's idle →
// pending → done state machine. The bulk action additionally renders an
// aria-live summary panel — the toast is the transient cue, the panel is the
// durable "what actually happened" detail (complementary, not redundant).

import { useState, useTransition } from "react";

import {
  sendOutreachRabiesReminderAction,
  sendOutreachRabiesRemindersBulkAction,
} from "@/app/actions/outreach-reminders";
import { OpButton } from "@/components/ui/dashboard/OpButton";
import type { OutreachReminderOutcome } from "@/lib/infra/outreach-reminders";
import { notifyActionError, notifySaved } from "@/lib/ui/action-feedback";
import { pluralizeEs, relativeDaysShort, speciesLabel } from "@/lib/utils/format";

export type OutreachRabiesReminderPet = {
  petId: string;
  petName: string;
  species: string;
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  lastVaccineAt: Date;
};

type RowState = "idle" | "pending" | OutreachReminderOutcome;

const OUTCOME_LABEL: Record<OutreachReminderOutcome, string> = {
  sent: "Recordatorio enviado",
  already_notified: "Ya avisado esta quincena",
  // Names the failure AND the next step. The operator is the only one who can
  // act on it, and the reminder is not coming back on its own: the daily drain
  // usually replays it, but a failed replay still stamps the dead-letter row
  // resolved. "Avisá por otra vía" is the same wording the decomiso pipeline
  // uses for the same situation.
  delivery_failed: "No se pudo enviar — avisá por otra vía",
  no_owner: "Sin propietario asignado",
  out_of_scope: "Fuera de tu jurisdicción",
};

const OUTCOME_TONE: Record<OutreachReminderOutcome, string> = {
  sent: "text-ln-op-ok",
  already_notified: "text-ln-op-mute",
  // Danger, not the muted grey it used to inherit from `already_notified`. A
  // failed delivery on an overdue-rabies campaign is the one row on this screen
  // that still needs a human.
  delivery_failed: "text-ln-op-danger",
  no_owner: "text-ln-op-mute",
  out_of_scope: "text-ln-op-danger",
};

type BulkSummary = {
  sent: number;
  alreadyNotified: number;
  deliveryFailed: number;
  noOwner: number;
  outOfScope: number;
};

function summaryLine(s: BulkSummary): string {
  const parts = [`${s.sent} ${pluralizeEs(s.sent, "enviado")}`];
  // Second, right after the good news and ahead of the benign buckets: it is
  // the only part of this line that asks the operator to do something.
  if (s.deliveryFailed > 0) {
    parts.push(
      `${s.deliveryFailed} sin ${pluralizeEs(s.deliveryFailed, "enviar")} — ${pluralizeEs(s.deliveryFailed, "avisá", "avisá")} por otra vía`,
    );
  }
  if (s.alreadyNotified > 0) {
    parts.push(
      `${s.alreadyNotified} ya ${pluralizeEs(s.alreadyNotified, "avisado")} esta quincena`,
    );
  }
  if (s.noOwner > 0) {
    parts.push(`${s.noOwner} sin propietario asignado`);
  }
  if (s.outOfScope > 0) {
    parts.push(`${s.outOfScope} fuera de tu jurisdicción`);
  }
  return parts.join(" · ");
}

export function OutreachRabiesReminderList({ pets }: { pets: OutreachRabiesReminderPet[] }) {
  const [, startTransition] = useTransition();
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [bulkSummary, setBulkSummary] = useState<BulkSummary | null>(null);
  const [bulkPending, setBulkPending] = useState(false);

  function stateFor(petId: string): RowState {
    return rowState[petId] ?? "idle";
  }

  function handleRemindOne(petId: string) {
    setRowState((s) => ({ ...s, [petId]: "pending" }));
    startTransition(async () => {
      const res = await sendOutreachRabiesReminderAction(petId);
      if (!res.ok) {
        setRowState((s) => ({ ...s, [petId]: "idle" }));
        notifyActionError(res.error);
        return;
      }
      const outcome = res.result.results[0]?.outcome ?? "already_notified";
      setRowState((s) => ({ ...s, [petId]: outcome }));
      if (outcome === "sent") notifySaved("Recordatorio enviado");
      else notifyActionError(OUTCOME_LABEL[outcome]);
    });
  }

  function handleRemindBulk() {
    setBulkSummary(null);
    setBulkPending(true);
    const petIds = pets.map((p) => p.petId);
    for (const id of petIds) setRowState((s) => ({ ...s, [id]: "pending" }));
    startTransition(async () => {
      const res = await sendOutreachRabiesRemindersBulkAction(petIds);
      setBulkPending(false);
      if (!res.ok) {
        for (const id of petIds) setRowState((s) => ({ ...s, [id]: "idle" }));
        notifyActionError(res.error);
        return;
      }
      setRowState((s) => {
        const next = { ...s };
        for (const r of res.result.results) next[r.petId] = r.outcome;
        return next;
      });
      setBulkSummary({
        sent: res.result.sentCount,
        alreadyNotified: res.result.alreadyNotifiedCount,
        deliveryFailed: res.result.deliveryFailedCount,
        noOwner: res.result.noOwnerCount,
        outOfScope: res.result.outOfScopeCount,
      });
      if (res.result.sentCount > 0) {
        notifySaved(
          `${res.result.sentCount} ${pluralizeEs(res.result.sentCount, "recordatorio")} enviado(s)`,
        );
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <OpButton
          onClick={handleRemindBulk}
          disabled={pets.length === 0}
          loading={bulkPending}
          size="sm"
        >
          {`Enviar recordatorios (${pets.length})`}
        </OpButton>
      </div>

      {bulkSummary && (
        <output
          aria-live="polite"
          className="block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-2.5 text-sm text-ln-op-ink"
        >
          {summaryLine(bulkSummary)}
        </output>
      )}

      <ul className="space-y-1" aria-label="Lista de mascotas con antirrábica vencida">
        {pets.map((pet) => {
          // epoch sentinel (new Date(0)) = pet never had a rabies vaccine on
          // record. Show "sin registro" instead of a meaningless "hace
          // 20624d"; real overdue dates render as a capped "hace Nd".
          const overdueLabel =
            pet.lastVaccineAt.getTime() === 0
              ? "sin registro"
              : relativeDaysShort(pet.lastVaccineAt);
          const state = stateFor(pet.petId);

          return (
            <li
              key={pet.petId}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 text-sm"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium text-ln-op-ink">{pet.petName}</p>
                <p className="text-ln-op-mute">
                  {speciesLabel(pet.species)} ·{" "}
                  {[pet.jurisdictionLocality, pet.jurisdictionProvince].filter(Boolean).join(", ")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="text-ln-op-danger font-medium tabular-nums">{overdueLabel}</span>
                {state === "idle" && (
                  <OpButton onClick={() => handleRemindOne(pet.petId)} variant="ghost" size="sm">
                    Recordar
                  </OpButton>
                )}
                {state === "pending" && <span className="text-sm text-ln-op-mute">Enviando…</span>}
                {state !== "idle" && state !== "pending" && (
                  <span className={`text-sm font-medium ${OUTCOME_TONE[state]}`}>
                    {OUTCOME_LABEL[state]}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
