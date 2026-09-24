"use client";

// ImportWizard — bulk-intake CSV wizard (org-pilot-pack Req 1, design D3).
//
// upload → preview (server-validated, nothing written) → confirm → sequential
// chunks of 5 through importIntakeRowsAction → per-row report with a
// failed-rows CSV re-download (template layout + error column, original data
// preserved — fix and re-upload without retyping the successful rows).
//
// Only VALID rows are ever submitted (spec 1.4); at zero valid rows the
// confirm CTA is disabled (spec 1.9). Exact full-row duplicates get a visual
// warning but import normally — littermates are legitimate (spec 1.10).
//
// A TANDA THAT THROWS ENDS THE RUN IN AN HONEST STATE (L-15). A chunk that
// RETURNS an error is reported per row and the run goes on; a chunk whose call
// THROWS (network cut, lambda killed, deploy mid-import) used to escape
// confirmImport entirely — the wizard sat on "Importando…" forever and the
// report of the rows already written was lost with it. Now the run stops at
// that tanda and lands on the report: the rows already written, plus how to
// finish. Resuming needs no new mechanism — it already existed and nothing on
// screen said so: every row's idempotency key is derived from the FILE's hash
// and the row's position, so re-uploading the SAME, UNMODIFIED file re-sends
// the written rows as no-ops and writes only the rest. An edited file has a
// different hash, which is why the copy insists on "sin modificarlo".
//
// THAT NO-OP ONLY COVERS THE WRITE STEP (code review, 2026-09-18). A row is
// re-validated by validateIntakeCsvAction BEFORE it ever reaches the
// idempotency check — and for a row that carries a chip or tattoo, the
// identifierPrecheckErrors lookup (validate-rows.ts) now finds the record the
// FIRST pass wrote and rejects the row as a possible identity match, exactly
// as it would for a genuinely new duplicate. That row lands in "Con errores"
// and the failed-rows CSV, not the imported list — it does NOT "figure again
// as imported". The interrupted-run banner below says so explicitly instead
// of promising a re-import label these rows will never show.

import { useRef, useState } from "react";

import { OpButton, OpFileInput } from "@/components/ui/dashboard";
import { buildFailedRowsCsv } from "@/lib/domain/intake-csv";
import { pluralizeEs } from "@/lib/utils/format";

import {
  type ImportIntakeRowResult,
  type IntakeCsvRowPreview,
  importIntakeRowsAction,
  validateIntakeCsvAction,
} from "./actions";

const CHUNK_SIZE = 5;

type WizardStep = "upload" | "preview" | "importing" | "report";

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

/**
 * Row number AS THE OPERATOR SEES IT IN THEIR SPREADSHEET.
 *
 * `index` is 0-based over DATA rows, so the wizard reported "Fila 1…4" while
 * Excel showed those same rows as 2…5 — row 1 is the header. Someone opening
 * the file to fix an error was sent to the wrong line every time, and the more
 * errors the file had the more the off-by-one cost (QA 2026-08-07).
 *
 * +2: one for the 0-based index, one for the header row. The label says "de la
 * planilla" at the call sites so the number is unambiguous about WHICH
 * numbering it belongs to — the wizard's own ordinal and the spreadsheet's are
 * genuinely different things, and naming the frame is cheaper than expecting
 * the reader to infer it.
 */
function spreadsheetRow(index: number): number {
  return index + 2;
}

export function ImportWizard({ orgToken }: { orgToken: string }) {
  const [step, setStep] = useState<WizardStep>("upload");
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [preview, setPreview] = useState<{
    fileHash: string;
    rows: IntakeCsvRowPreview[];
  } | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ImportIntakeRowResult[]>([]);
  // Set when a tanda THREW and the run stopped short (see the header).
  const [interrupted, setInterrupted] = useState<{
    atChunk: number;
    totalChunks: number;
    notConfirmed: number;
  } | null>(null);
  // Hiding the native control also hides the filename it used to print, so the
  // wizard now owns that feedback (OpFileInput `status`).
  const [selectedFileName, setSelectedFileName] = useState("");
  const [rowFilter, setRowFilter] = useState<"todas" | "validas" | "errores">("todas");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validRows = preview?.rows.filter((r) => r.valid) ?? [];
  const invalidRows = preview?.rows.filter((r) => !r.valid) ?? [];
  const shownRows =
    rowFilter === "validas"
      ? validRows
      : rowFilter === "errores"
        ? invalidRows
        : (preview?.rows ?? []);

  async function handleFileSelected(file: File) {
    setError(null);
    setValidating(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await validateIntakeCsvAction(orgToken, fd);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setPreview({ fileHash: res.fileHash, rows: res.rows });
      setResults([]);
      setInterrupted(null);
      setStep("preview");
    } catch {
      // Nothing is written by validation, so the honest message is short.
      setError(
        "No pudimos validar el archivo. No se importó nada. Probá de nuevo en unos minutos.",
      );
    } finally {
      setValidating(false);
    }
  }

  async function confirmImport() {
    if (!preview || validRows.length === 0) return;
    const rowsToImport = validRows.map((r) => ({ index: r.index, fields: r.fields }));
    const chunks = chunkRows(rowsToImport, CHUNK_SIZE);

    setStep("importing");
    setInterrupted(null);
    setProgress({ done: 0, total: chunks.length });

    const accumulated: ImportIntakeRowResult[] = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      let res: Awaited<ReturnType<typeof importIntakeRowsAction>>;
      try {
        res = await importIntakeRowsAction(orgToken, {
          fileHash: preview.fileHash,
          rows: chunk,
        });
      } catch {
        // The call itself died: whether THIS tanda's rows were written is
        // unknown, and the later tandas were never sent. Stop here and show
        // what is known — the same-file re-upload settles the rest without
        // duplicates (see the header).
        const unconfirmed = chunks.slice(chunkIndex).reduce((n, c) => n + c.length, 0);
        setResults(accumulated);
        setInterrupted({
          atChunk: chunkIndex + 1,
          totalChunks: chunks.length,
          notConfirmed: unconfirmed,
        });
        setStep("report");
        return;
      }
      if ("error" in res) {
        // A whole-chunk failure (auth loss, transient) still lands in the
        // report per row — a row that passed preview MAY fail at confirm and
        // MUST appear, never be silently dropped (spec 1.5).
        for (const row of chunk) {
          accumulated.push({ index: row.index, outcome: "failed", reason: res.error });
        }
      } else {
        accumulated.push(...res.results);
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setResults(accumulated);
    setStep("report");
  }

  function restartWithSameFile() {
    setPreview(null);
    setResults([]);
    setInterrupted(null);
    setSelectedFileName("");
    setError(null);
    setStep("upload");
  }

  function downloadFailedRowsCsv() {
    if (!preview) return;
    const failedFromPreview = invalidRows.map((r) => ({ record: r.record, errors: r.errors }));
    const failedFromImport = results
      .filter((r) => r.outcome !== "imported")
      .map((r) => {
        const row = preview.rows.find((p) => p.index === r.index);
        return { record: row?.record ?? {}, errors: [r.reason ?? "Falló al confirmar"] };
      });
    const csv = buildFailedRowsCsv([...failedFromPreview, ...failedFromImport]);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "filas-con-error.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const failedCount = invalidRows.length + results.filter((r) => r.outcome !== "imported").length;

  return (
    <div className="space-y-5">
      {/* Template download — always visible so the org can grab it any time. */}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={`/org/${orgToken}/intake/importar/template`}
          className="inline-flex items-center rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-1.5 text-md font-medium text-ln-op-ink hover:bg-ln-op-stripe transition-colors no-underline"
          download
        >
          Descargar plantilla
        </a>
        <span className="text-sm text-ln-op-mute">
          Completá la plantilla (una fila por animal, máximo 200) y subila acá.
        </span>
      </div>

      {/* The other direction (org-first readiness #4). The export uses this same
          layout, so what comes out can go back in — and an org that wants to
          correct twenty rows in Excel starts from its real data instead of an
          empty template. */}
      <p className="text-sm text-ln-op-mute">
        ¿Querés bajar lo que ya está cargado?{" "}
        <a href={`/org/${orgToken}/mascotas/exportar`} className="text-ln-op-azul hover:underline">
          Exportar CSV
        </a>
      </p>

      {step === "upload" && (
        <div className="space-y-3">
          {/* NOT a wrapping <label>: OpFileInput renders its own htmlFor label,
              and nesting labels is invalid HTML — the outer one would swallow
              the click and the picker would never open. Plain span + the
              component's own `id` association instead. */}
          <div className="space-y-1">
            <span id="csv-file-label" className="block text-md text-ln-op-ink">
              Archivo CSV
            </span>
            <OpFileInput
              ref={fileInputRef}
              accept=".csv,text/csv"
              disabled={validating}
              aria-labelledby="csv-file-label"
              status={selectedFileName}
              onChange={(e) => {
                const file = e.target.files?.[0];
                setSelectedFileName(file?.name ?? "");
                if (file) void handleFileSelected(file);
              }}
            />
          </div>
          {validating && <p className="text-sm text-ln-op-mute">Validando el archivo…</p>}
        </div>
      )}

      {error && (
        <p className="rounded-[var(--radius-md)] border border-ln-op-danger-bd bg-ln-op-danger-bg px-3 py-2 text-md text-ln-op-danger">
          {error}
        </p>
      )}

      {step === "preview" && preview && (
        <div className="space-y-4">
          {/* These counters USED to be inert <span>s wearing the same rounded,
              tinted shape as the queue chips on /gob — which do filter. A
              control that looks pressable and does nothing teaches the operator
              to distrust every chip in the product (QA 2026-08-07). PO decided
              to keep the affordance and honour it: they filter now.

              SHAPE COMES FROM THE HOUSE PATTERN, not from this file. The first
              version hand-rolled <button className="rounded-… border …"> and
              the raw-button fence caught it — correctly. CaseQueue's sort
              toggle already solves the identical problem (a LOCAL multi-state
              toggle over the same list, no URL to reflect into) with
              OpButton size="sm" + primary/ghost + aria-pressed inside a
              fieldset. Same problem, same answer: no third spelling.

              No ok/danger tint on the chips either — the per-row list right
              below already says which rows are valid, and colouring the filter
              as well states it twice. */}
          <fieldset className="flex flex-wrap items-center gap-3 text-md">
            <legend className="sr-only">Filtrar filas del archivo</legend>
            {(
              [
                ["todas", `Todas (${preview.rows.length})`],
                ["validas", `Válidas (${validRows.length})`],
                ["errores", `Con errores (${invalidRows.length})`],
              ] as const
            ).map(([value, label]) => {
              const active = rowFilter === value;
              return (
                <OpButton
                  key={value}
                  type="button"
                  size="sm"
                  variant={active ? "primary" : "ghost"}
                  aria-pressed={active}
                  onClick={() => setRowFilter(value)}
                >
                  {label}
                </OpButton>
              );
            })}
          </fieldset>

          <ul className="divide-y divide-ln-op-line rounded-[var(--radius-md)] border border-ln-op-line">
            {shownRows.length === 0 && (
              <li className="px-3 py-4 text-md text-ln-op-mute">
                No hay filas {rowFilter === "validas" ? "válidas" : "con errores"} en este archivo.
              </li>
            )}
            {shownRows.map((row) => (
              <li key={row.index} className="px-3 py-2 text-md space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-ln-mono text-sm text-ln-op-mute">
                    Fila {spreadsheetRow(row.index)} de la planilla
                  </span>
                  <span className="font-medium text-ln-op-ink">
                    {row.record["nombre*"] ?? row.record.nombre ?? "(sin nombre)"}
                  </span>
                  {row.valid ? (
                    <span className="text-sm text-ln-op-ok">válida</span>
                  ) : (
                    <span className="text-sm text-ln-op-danger">con errores</span>
                  )}
                  {row.duplicate && (
                    <span className="rounded-[var(--radius-sm)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-1.5 py-0.5 text-sm text-ln-op-warn">
                      Fila duplicada dentro del archivo
                    </span>
                  )}
                </div>
                {row.errors.length > 0 && (
                  <ul className="list-disc pl-5 text-sm text-ln-op-danger">
                    {row.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-3">
            <OpButton
              type="button"
              onClick={confirmImport}
              disabled={validRows.length === 0}
              variant="primary"
            >
              Confirmar importación
            </OpButton>
            {invalidRows.length > 0 && (
              <OpButton type="button" onClick={downloadFailedRowsCsv} variant="ghost">
                Descargar filas con error
              </OpButton>
            )}
            <OpButton
              type="button"
              variant="ghost"
              onClick={() => {
                setPreview(null);
                setStep("upload");
              }}
            >
              Elegir otro archivo
            </OpButton>
          </div>
          {validRows.length === 0 && (
            <p className="text-sm text-ln-op-mute">
              No hay filas válidas para importar. Corregí los errores y volvé a subir el archivo.
            </p>
          )}
        </div>
      )}

      {step === "importing" && (
        // <output> is the semantic live-region element (biome a11y rule) —
        // announces chunk progress without an explicit role.
        <output className="block space-y-2">
          <p className="text-md text-ln-op-ink">
            Importando… tanda {Math.min(progress.done + 1, progress.total)} de {progress.total}
          </p>
          <div className="h-2 w-full rounded-full bg-ln-op-stripe">
            <div
              className="h-2 rounded-full bg-ln-op-azul transition-all"
              style={{
                width: `${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`,
              }}
            />
          </div>
        </output>
      )}

      {step === "report" && preview && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-ln-op-mute">
            Resultado de la importación
          </h2>

          {interrupted && (
            <div
              role="alert"
              className="space-y-2 rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-3 text-md text-ln-op-ink"
            >
              <p className="font-medium text-ln-op-warn">
                La importación se cortó en la tanda {interrupted.atChunk} de{" "}
                {interrupted.totalChunks}.
              </p>
              <p>
                {results.length === 0
                  ? "No llegamos a confirmar ninguna fila antes del corte."
                  : "Las filas de abajo ya quedaron registradas."}{" "}
                Quedan {interrupted.notConfirmed} {pluralizeEs(interrupted.notConfirmed, "fila")}{" "}
                sin confirmar: las de la tanda que se cortó pueden haberse registrado o no.
              </p>
              <p>
                Para terminar, volvé a subir el mismo archivo, sin modificarlo. Las filas sin chip
                ni tatuaje que ya quedaron registradas se reconocen solas y no se duplican (van a
                figurar otra vez como importadas); solo se registran las que faltan. Las filas CON
                chip o tatuaje que ya se cargaron van a aparecer con un error de "posible
                coincidencia" en vez de como importadas — esa es la señal de que ya están, no las
                cargues de nuevo a mano por el formulario individual.
              </p>
              <OpButton type="button" variant="primary" onClick={restartWithSameFile}>
                Volver a subir el archivo
              </OpButton>
            </div>
          )}

          <ul className="divide-y divide-ln-op-line rounded-[var(--radius-md)] border border-ln-op-line">
            {results.map((result) => (
              <li
                key={result.index}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-md"
              >
                <div className="min-w-0 space-y-0.5">
                  <span className="font-ln-mono text-sm text-ln-op-mute">
                    Fila {spreadsheetRow(result.index)} de la planilla
                  </span>{" "}
                  {result.outcome === "imported" && (
                    <span className="text-ln-op-ok">Importada — {result.petName}</span>
                  )}
                  {result.outcome === "failed" && (
                    <span className="text-ln-op-danger">Falló: {result.reason}</span>
                  )}
                  {result.outcome === "skipped" && (
                    <span className="text-ln-op-warn">Salteada: {result.reason}</span>
                  )}
                </div>
                {result.outcome === "imported" && result.petToken && (
                  <a
                    href={`/org/${orgToken}/mascotas/${result.petToken}`}
                    className="shrink-0 rounded-[var(--radius-md)] border border-ln-op-line px-3 py-1.5 text-sm text-ln-op-ink hover:bg-ln-op-stripe transition-colors no-underline"
                  >
                    Ver ficha
                  </a>
                )}
              </li>
            ))}
          </ul>

          {failedCount > 0 && (
            <OpButton type="button" onClick={downloadFailedRowsCsv} variant="ghost">
              Descargar filas con error
            </OpButton>
          )}
        </div>
      )}
    </div>
  );
}
