/**
 * RA-9 — the seven accessibility barriers (BR-1 … BR-7).
 *
 * Pattern: react-dom/server renderToStaticMarkup for anything renderable (repo
 * convention), plus source-level fences for the behaviours that only exist in a
 * real browser (focus trap, top layer, inertness, Escape). A fence cannot prove
 * focus lands anywhere — it CAN prove the code that asks the platform for it is
 * still there, which is what regressed in the first place.
 *
 * NOT covered here (needs a browser; see the RA-9 report):
 *   - that showModal() actually traps Tab and inerts the background
 *   - that Escape reaches the popovers' document keydown listeners
 *   - that a screen reader speaks aria-describedby on dialog open
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StackedTimeSeriesChart } from "@/components/charts/StackedTimeSeriesChart";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LnRadioGroup } from "@/components/ui/Field";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));

const ROOT = join(__dirname, "..");

/** Comments quoting the old code have fooled this wave repeatedly — strip them
 *  before every source assertion so a fence can only match executable code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/[^"'`]*$/, ""))
    .join("\n");
}

function source(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), "utf8"));
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (abs.endsWith(".tsx")) yield abs;
  }
}

// ---------------------------------------------------------------------------
// BR-1 — the decomiso confirm was a NON-MODAL <dialog open>
// ---------------------------------------------------------------------------

// `<dialog open>` is explicitly NON-modal: no top layer, no inertness for the
// rest of the document, and no native cancel/Escape. The only correct way to
// open a modal dialog is the imperative showModal().
// The lookahead is what keeps Tailwind's `open:` variant (`open:flex`, used by
// ConfirmDialog and DetailDrawer inside className strings) out of the match.
const BARE_DIALOG_OPEN = /<dialog\b[^>]*?\sopen(?=[\s>/])/s;

describe("BR-1 — every <dialog> in the repo is driven by showModal()", () => {
  it("no .tsx renders a <dialog> with a literal `open` attribute", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components", "src"]) {
      const abs = join(ROOT, dir);
      try {
        if (!statSync(abs).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of walk(abs)) {
        if (file.endsWith(".test.tsx")) continue;
        const src = stripComments(readFileSync(file, "utf8"));
        if (BARE_DIALOG_OPEN.test(src)) offenders.push(relative(ROOT, file).split(sep).join("/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the fence actually fires — a guard that matches nothing is not a guard", () => {
    expect(BARE_DIALOG_OPEN.test('<dialog\n  open\n  aria-labelledby="x"\n>')).toBe(true);
    expect(BARE_DIALOG_OPEN.test('<dialog ref={r} className="open:flex open:flex-col">')).toBe(
      false,
    );
    expect(BARE_DIALOG_OPEN.test("<dialog ref={r} onClose={onClose}>")).toBe(false);
  });

  it("DecomisoForm's double-confirm rides the vetted ConfirmDialog primitive", () => {
    const src = source("app/gob/decomisos/nuevo/_components/DecomisoForm.tsx");
    expect(src).toContain('from "@/components/ui/ConfirmDialog"');
    expect(src).toContain("<ConfirmDialog");
    // Focus must return to the trigger when the modal closes.
    expect(src).toContain("triggerRef={submitRef}");
    expect(src).toContain("ref={submitRef}");
    // D.3 grammar: the button carries the verb of the act.
    expect(src).toContain('confirmLabel="Ejecutar decomiso"');
  });
});

// ---------------------------------------------------------------------------
// BR-2 — bulk revoke: real modality + an announced result
// ---------------------------------------------------------------------------

describe("BR-2 — BulkRevokeList modal", () => {
  const src = source("components/BulkRevokeList.tsx");

  it("is a native <dialog> opened with showModal(), not a div claiming aria-modal", () => {
    expect(src).toContain("<dialog");
    expect(src).toContain("el.showModal()");
    // The old lie: aria-modal="true" on a plain div with nothing inert.
    expect(src).not.toMatch(/role="dialog"/);
  });

  it("syncs the native cancel event (Escape) back to React state", () => {
    expect(src).toContain('el.addEventListener("cancel", handleCancel)');
  });

  it("moves focus into the modal and restores it to the opener on close", () => {
    expect(src).toContain("motivoRef.current?.focus()");
    expect(src).toContain("opener.focus()");
  });

  it("announces the bulk outcome via a live region and focuses it", () => {
    expect(src).toContain('<output aria-live="polite"');
    expect(src).toContain("resultHeadingRef.current?.focus()");
  });
});

// ---------------------------------------------------------------------------
// BR-3 — the consequence sentence must be part of the dialog announcement
// ---------------------------------------------------------------------------

describe("BR-3 — ConfirmDialog announces its consequence", () => {
  it("wires aria-describedby to the description paragraph", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={() => {}}
        title="Aceptar custodia"
        description="Tu organización asume la custodia de Pampa bajo Ley 14.346. No se puede deshacer."
        confirmLabel="Aceptar custodia"
      />,
    );
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    // The referenced id must exist on the element carrying the consequence text.
    const descEl = html.match(new RegExp(`<p id="${describedBy}"[^>]*>([^<]+)</p>`));
    expect(descEl?.[1]).toContain("Ley 14.346");
  });

  it("omits aria-describedby when there is no description to point at", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        onClose={() => {}}
        onConfirm={() => {}}
        title="Eliminar regla"
        confirmLabel="Eliminar"
      />,
    );
    expect(html).not.toContain("aria-describedby");
  });

  it("all four wave-added modals pass a description, so all four now announce it", () => {
    // acd08f43 added these four; BR-3 is what made their consequence sentence
    // silent. The fix is in the shared primitive — this pins that each call site
    // actually supplies the sentence for it to announce.
    for (const rel of [
      "app/gob/disputas/[disputeToken]/ResolveDisputeForm.tsx",
      "app/org/[orgToken]/mascotas/[publicToken]/foster-fin/EndFosterForm.tsx",
      "app/org/[orgToken]/transferencias/recibidas/DecomisoHandoffActions.tsx",
    ]) {
      const src = source(rel);
      expect(src, rel).toContain("<ConfirmDialog");
      expect(src, rel).toMatch(/description=/);
    }
  });
});

// ---------------------------------------------------------------------------
// BR-4 — nav popovers of links are lists of links, not application menus
// ---------------------------------------------------------------------------

describe("BR-4 — no role=menu over bare links", () => {
  for (const rel of [
    "components/layout/ContextSwitcher.tsx",
    "components/layout/AppCitizenMasthead.tsx",
  ]) {
    it(`${rel} declares neither role="menu" nor role="menuitem"`, () => {
      const src = source(rel);
      expect(src).not.toContain('role="menu"');
      expect(src).not.toContain('role="menuitem"');
    });

    it(`${rel} closes on Escape and returns focus to its trigger`, () => {
      const src = source(rel);
      expect(src).toContain('e.key !== "Escape"');
      expect(src).toContain("triggerRef.current?.focus()");
    });
  }

  it("ContextSwitcher renders its destinations as a real list inside a named nav", () => {
    const src = source("components/layout/ContextSwitcher.tsx");
    expect(src).toContain('aria-label="Cambiar de portal"');
    expect(src).toContain("<li>");
  });
});

// ---------------------------------------------------------------------------
// BR-5 / BR-7 — chart accessible names, and disambiguated "Ver datos" toggles
// ---------------------------------------------------------------------------

describe("BR-5 — the two recharts wrappers have an accessible name", () => {
  it("TimeSeriesChart wraps the plot in figure[role=img] with an aria-label", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        data={[
          { x: "Ene", y: 3 },
          { x: "Feb", y: 5 },
        ]}
        seriesLabel="Denuncias"
        fallbackTableLabel="Denuncias por mes"
      />,
    );
    expect(html).toMatch(/<figure[^>]*role="img"/);
    const label = html.match(/<figure[^>]*aria-label="([^"]+)"/)?.[1];
    expect(label).toContain("Denuncias");
    expect(label).toContain("2 períodos");
  });

  it("StackedTimeSeriesChart wraps the plot in figure[role=img] with an aria-label", () => {
    const html = renderToStaticMarkup(
      <StackedTimeSeriesChart
        seriesKeys={["a", "b"]}
        points={[{ x: "S1", values: { a: 1, b: 2 } }]}
        seriesLabels={{ a: "Atropello", b: "Enfermedad" }}
        fallbackTableLabel="Causas por semana"
      />,
    );
    expect(html).toMatch(/<figure[^>]*role="img"/);
    const label = html.match(/<figure[^>]*aria-label="([^"]+)"/)?.[1];
    expect(label).toContain("Causas por semana");
    expect(label).toContain("Atropello");
  });

  it("the data table stays OUTSIDE role=img — role=img makes its subtree presentational", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart data={[{ x: "Ene", y: 3 }]} seriesLabel="Denuncias" />,
    );
    const figureEnd = html.indexOf("</figure>");
    const detailsStart = html.indexOf("<details");
    expect(figureEnd).toBeGreaterThan(-1);
    expect(detailsStart).toBeGreaterThan(figureEnd);
  });
});

describe('BR-7 — "Ver datos" toggles name their dataset', () => {
  it("TimeSeriesChart suffixes the summary with the table label", () => {
    const html = renderToStaticMarkup(
      <TimeSeriesChart
        data={[{ x: "Ene", y: 3 }]}
        seriesLabel="Denuncias"
        fallbackTableLabel="Denuncias por mes"
      />,
    );
    expect(html).toContain('Ver datos<span class="sr-only"> — Denuncias por mes</span>');
  });

  it("StackedTimeSeriesChart suffixes the summary with the table label", () => {
    const html = renderToStaticMarkup(
      <StackedTimeSeriesChart
        seriesKeys={["a"]}
        points={[{ x: "S1", values: { a: 1 } }]}
        seriesLabels={{ a: "Atropello" }}
        fallbackTableLabel="Causas por semana"
      />,
    );
    expect(html).toContain('Ver datos<span class="sr-only"> — Causas por semana</span>');
  });

  it("no chart ships a bare, undisambiguated 'Ver datos' summary", () => {
    for (const rel of [
      "components/charts/TimeSeriesChart.tsx",
      "components/charts/StackedTimeSeriesChart.tsx",
      "components/charts/ForecastChart.tsx",
      "components/charts/MapChoropleth.tsx",
      "components/panorama/CalendarHeatmap.tsx",
    ]) {
      const src = source(rel);
      expect(src, rel).toMatch(/Ver datos<span className="sr-only"> — /);
    }
  });
});

// ---------------------------------------------------------------------------
// BR-6 — required radio groups say so to assistive tech
// ---------------------------------------------------------------------------

describe("BR-6 — LnRadioGroup carries requiredness to assistive tech", () => {
  it("renders role=radiogroup + aria-required + an sr-only '(obligatorio)'", () => {
    const html = renderToStaticMarkup(
      <LnRadioGroup legend="¿Sobre quién?" required>
        <input type="radio" name="k" value="a" readOnly />
      </LnRadioGroup>,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-required="true"');
    expect(html).toContain('<span class="sr-only"> (obligatorio)</span>');
    // The glyph stays decorative — it is not the signal.
    expect(html).toMatch(/aria-hidden="true"[^>]*>\s*\*/);
  });

  it("an optional group is not marked required", () => {
    const html = renderToStaticMarkup(
      <LnRadioGroup legend="¿Sobre quién?">
        <input type="radio" name="k" value="a" readOnly />
      </LnRadioGroup>,
    );
    expect(html).not.toContain("aria-required");
    expect(html).not.toContain("(obligatorio)");
  });

  it("the four hand-rolled required fieldsets now route through the primitive", () => {
    for (const rel of [
      "app/(public)/denuncias/nueva/WelfareReportForm.tsx",
      "app/(public)/denuncias/nueva/_components/Step3Where.tsx",
      "app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura/BiteForm.tsx",
      "app/org/[orgToken]/mordedura/nuevo/OrgBiteForm.tsx",
    ]) {
      const src = source(rel);
      expect(src, rel).toContain("<LnRadioGroup");
      expect(src, rel).toContain("LnRadioGroup");
    }
  });
});
