"use client";

// RevokeTagDialog — confirms revocation of an ACTIVE physical tag.
//
// Revocation is terminal (state machine: active → revoked, no reuse), so the
// dialog demands an explicit reason before enabling the confirm button. On
// success the page reloads to show the revoked state.
//
// Controlled `open`: the parent TagList owns which row's panel is open so
// only one can be open at a time (Cowork QA v3, B3).
//
// The reason select's id comes from useId(), NEVER a literal: TagList renders
// one of these per ACTIVE chapa, so a hardcoded id made N labels and N selects
// share it, and `label.control` (hence `select.labels`) resolved to the FIRST
// select in the document for every row — the visible label belonged to another
// row's control, so the select had no accessible name and clicking the label
// focused a control inside a CLOSED <dialog>. Same duplicate-id-in-a-repeated-
// row class components/MotivoField.tsx already fixed the same way.

import { useId, useState, useTransition } from "react";

import { revokeTagAction } from "@/app/actions/tags";
import { LnButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LnSelect } from "@/components/ui/Field";
import type { PetTagRevokeReason } from "@/db/schema";

const REASON_OPTIONS: Array<{ value: PetTagRevokeReason; label: string }> = [
  { value: "lost", label: "Se perdió la chapa" },
  { value: "damaged", label: "Está dañada o ilegible" },
  { value: "transfer", label: "La mascota cambió de dueño/a" },
  { value: "fraud", label: "Uso fraudulento" },
  { value: "owner_request", label: "Ya no la quiero usar" },
  { value: "other", label: "Otro motivo" },
];

export function RevokeTagDialog({
  serial,
  open,
  onOpenChange,
}: {
  serial: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState<PetTagRevokeReason | "">("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    if (!reason) return;
    startTransition(async () => {
      const result = await revokeTagAction({ serial, revokeReason: reason });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      window.location.reload();
    });
  }

  return (
    <>
      <LnButton
        variant="ghost"
        size="sm"
        onClick={() => {
          setReason("");
          setError(null);
          onOpenChange(true);
        }}
      >
        Dar de baja
      </LnButton>

      <ConfirmDialog
        open={open}
        onClose={() => onOpenChange(false)}
        onConfirm={handleConfirm}
        title={`Dar de baja la chapa ${serial}`}
        description="La baja es definitiva: el QR de esta chapa deja de mostrar la credencial y la chapa no se puede reactivar."
        confirmLabel="Dar de baja"
        cancelLabel="Cancelar"
        tone="danger"
        pending={isPending}
      >
        <div className="px-5 pb-3 space-y-2">
          <label
            htmlFor={reasonId}
            className="block text-sm font-medium text-[var(--color-ln-ink-2)]"
          >
            Motivo <span className="text-[var(--color-ln-mute)]">(obligatorio)</span>
          </label>
          <LnSelect
            id={reasonId}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value as PetTagRevokeReason | "");
              setError(null);
            }}
          >
            <option value="">Elegí un motivo…</option>
            {REASON_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </LnSelect>
          {error && (
            <p className="text-sm text-[var(--color-ln-err)]" role="alert">
              {error}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
