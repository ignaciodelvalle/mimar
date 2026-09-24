"use client";

// IssueTagBatchForm — count + lote id → issueTagBatchAction → CSV download.
//
// The CSV (`serial,activation_code,url`) is built CLIENT-SIDE from the action
// response and downloaded immediately. The plaintext codes live only in that
// response/blob — never persisted, never logged, never re-shown after the
// summary is dismissed.

import { useState, useTransition } from "react";

import { issueTagBatchAction } from "@/app/actions/tags";
import { OpButton } from "@/components/ui/dashboard/OpButton";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard/OpCard";
import { OpField, OpInput } from "@/components/ui/dashboard/OpField";
import { buildTagIssuanceCsv } from "@/src/modules/pets/application/tags/issuance-csv";

export function IssueTagBatchForm() {
  const [count, setCount] = useState("50");
  const [loteId, setLoteId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issuedSummary, setIssuedSummary] = useState<{ lote: string; count: number } | null>(null);
  const [isPending, startTransition] = useTransition();

  const parsedCount = Number.parseInt(count, 10);
  const canSubmit =
    Number.isInteger(parsedCount) && parsedCount >= 1 && parsedCount <= 500 && loteId.trim() !== "";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || isPending) return;
    setError(null);
    setIssuedSummary(null);
    startTransition(async () => {
      const result = await issueTagBatchAction({ count: parsedCount, loteId: loteId.trim() });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const csv = buildTagIssuanceCsv(result.rows, window.location.origin);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chapas-${loteId.trim()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setIssuedSummary({ lote: loteId.trim(), count: result.rows.length });
    });
  }

  return (
    <OpCard>
      <OpCardHead title="Emitir lote" />
      <OpCardBody>
        <form onSubmit={handleSubmit} className="space-y-4">
          <OpField label="Cantidad de chapas" hint="Entre 1 y 500 por lote." required>
            {({ id, describedBy, invalid }) => (
              <OpInput
                id={id}
                type="number"
                min={1}
                max={500}
                value={count}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => {
                  setCount(e.target.value);
                  setError(null);
                }}
              />
            )}
          </OpField>

          <OpField
            label="Identificador de lote"
            hint="Ej: LOTE-2026-08-A. Queda registrado en cada chapa y en la auditoría."
            required
          >
            {({ id, describedBy, invalid }) => (
              <OpInput
                id={id}
                value={loteId}
                maxLength={64}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => {
                  setLoteId(e.target.value);
                  setError(null);
                }}
              />
            )}
          </OpField>

          {error && <p className="text-xs text-ln-op-danger">{error}</p>}
          {issuedSummary && (
            <p className="text-xs text-ln-op-ink-2">
              Lote {issuedSummary.lote}: {issuedSummary.count} chapas emitidas. El CSV se descargó a
              tu equipo — los códigos no se pueden volver a consultar.
            </p>
          )}

          <OpButton type="submit" disabled={!canSubmit || isPending}>
            {isPending ? "Emitiendo…" : "Emitir y descargar CSV"}
          </OpButton>
        </form>
      </OpCardBody>
    </OpCard>
  );
}
