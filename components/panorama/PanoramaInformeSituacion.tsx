"use client";

// PanoramaInformeSituacion — the print-ready operator briefing (task #55).
//
// Renders the pure InformeModel (panorama-informe.ts) as a self-contained,
// print-only document that captures the CURRENT panorama view as a shareable /
// attachable artifact a funcionario can hand to a colleague to justify a
// decision. It reuses the SAME lightweight print plumbing as the denuncia
// comprobante (DescargarComprobante): a scoped `@media print` stylesheet plus
// deferPrint() → window.print(), which produces a PDF on every browser's
// print-to-PDF path. NO heavy PDF lib (html-to-image / html2canvas are not in
// this project); NO new data fetch — the console already has every number.
//
// SCREEN-HIDDEN: the node is display:none on screen (`hidden`) and only becomes
// visible when the browser enters print. The print stylesheet hides the rest of
// the console and reveals ONLY this node (the classic "print one element" recipe
// using visibility), so the operator prints the briefing, not the live map UI
// behind it.
//
// PAGING (PRN-3, fixed 2026-08-05): that recipe used to end in
// `position: absolute; left: 0; top: 0`, which does NOT escape this console —
// AppShell's operator root is `position: fixed` (a positioned ancestor) and
// PanoramaShell adds its own `overflow-hidden` box with an inline height. The
// informe therefore printed as ONE page and lost exactly the content the header
// comment below promises is never dropped: the ranking, the method notes and the
// k-anon disclosure. The fix neutralises the whole ancestor chain under print —
// the shell via components/layout/operator-print-escape.css, the console's own
// two boxes below — and lets the briefing print in normal flow.
//
// HONESTY: this is a govt decision-justification artifact, so the demo banner,
// the k-anon disclosure, and the method notes are always present here — never
// dropped (project working norm). es-AR user copy, English identifiers.

import type { InformeModel } from "@/components/panorama/panorama-informe";

import "@/components/layout/operator-print-escape.css";

type Props = {
  model: InformeModel;
};

// Scoped print CSS: hide everything, then reveal only the informe and force a
// clean black-on-white document. Static — no user input (mirrors the comprobante).
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  [data-panorama-informe] { display: block !important; }
  [data-panorama-informe], [data-panorama-informe] * {
    visibility: visible !important;
    color: #000 !important;
    background: transparent !important;
    border-color: #bbb !important;
  }
  .panorama-console-shell,
  .panorama-console-root {
    display: block !important;
    overflow: visible !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    width: auto !important;
    margin: 0 !important;
  }
  .panorama-console-root > :not([data-panorama-informe]) { display: none !important; }
  [data-panorama-informe] {
    position: static;
    width: 100%;
    padding: 24px 28px;
    background: #fff !important;
    font-size: 12px;
    line-height: 1.5;
  }
  [data-panorama-informe] header,
  [data-panorama-informe] li,
  [data-panorama-informe] tr { break-inside: avoid; }
  [data-panorama-informe] h2 { break-after: avoid; }
}
`.trim();

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
      {children}
    </h2>
  );
}

export function PanoramaInformeSituacion({ model }: Props) {
  return (
    <div data-panorama-informe className="hidden">
      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static print CSS, no user input
        dangerouslySetInnerHTML={{ __html: PRINT_CSS }}
      />
      <article className="mx-auto max-w-3xl space-y-6 text-ln-op-ink">
        {/* Header — title + scope, the "situación al" corte, the period, and the
            generation stamp. */}
        <header className="space-y-2 border-b border-ln-op-line pb-4">
          <h1 className="text-xl font-bold tracking-tight">{model.title}</h1>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ln-op-ink-2">
            <span className="font-semibold">{model.asOfLabel}</span>
            <span>Período: {model.periodLabel}</span>
            <span>Alcance: {model.scopeLabel}</span>
          </div>
          {model.generatedAtLabel && (
            <p className="text-xs text-ln-op-mute">Generado el {model.generatedAtLabel}.</p>
          )}
          {/* Honesty banner — always present when the dataset is demo (never dropped). */}
          {model.isDemo && (
            <p className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-2 text-xs text-ln-op-ink-2">
              <span className="font-semibold">Datos de demostración.</span>{" "}
              {model.demoText.replace("Datos de demostración. ", "")}
            </p>
          )}
        </header>

        {/* One-line view description — the ViewState "explain" gift. */}
        {model.viewSummary && (
          <p className="text-sm leading-snug text-ln-op-ink-2">{model.viewSummary}</p>
        )}

        {/* KPIs — value + estado-actual/temporal framing + delta.
            P2-2: the section only exists when it has something to say. The three
            outcomes are NOT interchangeable and the order below is the claim:
              - kpisDegradedText → the fan-out FAILED. Declared, never hidden: a
                silent drop would print an all-clear over "we are blind", the
                exact defect the honesty invariant exists to kill.
              - kpis.length > 0  → print them.
              - neither          → ABSENT (the builder emits `kpis: []` with no
                degraded text only when this view has no indicators at all).
                Heading + "Sin indicadores para esta vista." is structure over
                nothing, so the whole section goes. Nothing is withheld here —
                k-anon suppression lives in the ranking's own note, which this
                branch cannot reach. */}
        {(model.kpisDegradedText || model.kpis.length > 0) && (
          <section>
            <SectionTitle>Indicadores</SectionTitle>
            {model.kpisDegradedText ? (
              <p className="text-sm text-ln-op-warn">{model.kpisDegradedText}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-3">
                {model.kpis.map((k) => (
                  <li
                    key={k.id}
                    className="space-y-0.5 rounded-[var(--radius-md)] border border-ln-op-line px-3 py-2"
                  >
                    <p className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-ln-op-mute">{k.label}</span>
                      {k.stateTag && (
                        <span className="shrink-0 rounded-full border border-ln-op-line px-1.5 py-0.5 text-xs uppercase tracking-wide text-ln-op-mute">
                          {k.stateTag}
                        </span>
                      )}
                    </p>
                    <p className="text-lg font-bold tabular-nums">{k.value}</p>
                    {k.deltaLabel && (
                      <p className="text-xs tabular-nums text-ln-op-ink-2">{k.deltaLabel}</p>
                    )}
                    {k.sub && <p className="text-xs leading-snug text-ln-op-mute">{k.sub}</p>}
                    {k.secondary && (
                      <p className="text-xs leading-snug text-ln-op-mute">{k.secondary}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Ranking — "Peores N · {métrica}" with the C1 metric label and the C3
            k-anon "protegido" disclosure (reused, not reinvented). */}
        {model.ranking && (
          <section>
            <SectionTitle>{model.ranking.heading}</SectionTitle>
            {model.ranking.rows.length === 0 ? (
              <p className="text-sm text-ln-op-mute">{model.ranking.emptyText}</p>
            ) : (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-ln-op-line text-left text-xs uppercase tracking-wide text-ln-op-faint">
                    <th className="w-6 py-1 font-semibold">#</th>
                    <th className="py-1 font-semibold">Unidad</th>
                    <th className="py-1 text-right font-semibold">{model.ranking.columnLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {model.ranking.rows.map((row) => (
                    <tr key={row.key} className="border-b border-ln-op-line/60">
                      <td className="py-1 tabular-nums text-ln-op-mute">{row.rank}</td>
                      <td className="py-1">{row.label}</td>
                      <td className="py-1 text-right tabular-nums">
                        {row.value}
                        {row.gapText && <span className="ml-2 text-ln-op-warn">{row.gapText}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {model.ranking.suppressedNote && (
              <p className="mt-2 text-xs text-ln-op-mute">{model.ranking.suppressedNote}</p>
            )}
          </section>
        )}

        {/* Active layers + the plain-language map caption.
            P2-2: with no layers AND no caption the section is a heading over
            "Sin capas activas." — a restatement of its own absence. It goes.
            The caption alone is enough to keep it: it describes what the map
            showed, which is the reason this section exists. This branch is pure
            view state (which layers the operator turned on), so it can never
            hide a k-anon suppression or a failed calculation. */}
        {(model.activeLayerLabels.length > 0 || model.caption) && (
          <section>
            <SectionTitle>Capas de la vista</SectionTitle>
            {model.activeLayerLabels.length > 0 ? (
              <p className="text-sm text-ln-op-ink-2">{model.activeLayerLabels.join(" · ")}</p>
            ) : (
              <p className="text-sm text-ln-op-mute">Sin capas activas.</p>
            )}
            {model.caption && (
              <p className="mt-1 text-sm leading-snug text-ln-op-mute">{model.caption}</p>
            )}
          </section>
        )}

        {/* Method / footnote block + the k-anon disclosure. */}
        <footer className="space-y-2 border-t border-ln-op-line pt-4 text-xs leading-snug text-ln-op-mute">
          <SectionTitle>Acerca de las métricas</SectionTitle>
          {model.methodNotes.length > 0 && (
            <ul className="list-disc space-y-1 pl-4">
              {model.methodNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p>{model.kAnonDisclosure}</p>
          <p>
            Fuente: miMAR — Centro de Situación Nacional. Toda vista es una proyección del registro
            de eventos.
          </p>
          {/* E1 — traceability: the URL that reproduces this exact view. Printed
              as plain text (paper is not clickable) and broken anywhere so a
              long query string does not overflow the page. */}
          {model.viewUrl && (
            <p className="break-all">
              Vista reproducible (requiere acceso al sistema):{" "}
              <span className="font-ln-mono">{model.viewUrl}</span>
            </p>
          )}
          {/* "Citar esta vista" v1 — the provenance disclosure sits WITH the
              reproducible-URL line: the URL above says how to replay the cut;
              this says exactly what the cut does and does NOT freeze (the
              «estado actual» stocks and the k<5 suppression survive an asOf
              pin by design — honest by disclosure, not by fake determinism). */}
          {model.citationDisclosure && <p>{model.citationDisclosure}</p>}
          {/* V2 — the scope as an OBJECT, not as prose. The URL above says WHERE
              this came from; this says exactly WHAT was asked, in a form that can
              be re-executed. Printed in full (it is short) so a page detached
              from this system still carries everything needed to regenerate its
              own numbers. NOT a signature and not an expediente number — those
              are separate, PO-gated concerns; this is the payload they will
              sign. Jurisdictions only: the block never names a person. */}
          {model.scopeDescriptor && (
            <div className="space-y-1 border-t border-ln-op-line pt-2">
              <p>
                <span className="font-semibold">Alcance verificable</span> — mandato:{" "}
                {model.scopeDescriptor.mandate}
                {model.scopeDescriptor.narrowed && <> · vista: {model.scopeDescriptor.narrowed}</>}{" "}
                · id de vista: <span className="font-ln-mono">{model.scopeDescriptor.viewId}</span>
              </p>
              <p className="break-all font-ln-mono text-xs leading-tight">
                {model.scopeDescriptor.json}
              </p>
            </div>
          )}
        </footer>
      </article>
    </div>
  );
}
