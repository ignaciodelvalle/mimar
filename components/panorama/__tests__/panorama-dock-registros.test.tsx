// The dock's Registros pane — extracted from PanoramaConsole under the
// file-size fence (RA-7 truth pass, 2026-08-01).
//
// What is worth testing here is not the table (MapDataTable has its own tests)
// but the DISCLOSURES: each one exists because two honest numbers on this board
// measure different universes, and an unnamed smaller number reads as a
// contradiction rather than a narrower claim.
//
// Pattern: renderToStaticMarkup — the pane is pure props → DOM.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MapDataTable } from "@/components/panorama/MapDataTable";
import type { MapTableRow } from "@/components/panorama/map-table-csv";
import { buildViewMeta, initialState } from "@/components/panorama/panorama-console-helpers";
import type { DockRecordSummary } from "@/components/panorama/panorama-map-table";
import {
  buildMapTableCaption,
  deriveLiveScopeLabel,
  resolveScopeLabel,
} from "@/components/panorama/scope-truth";
import { panoramaScopeLabel } from "@/lib/panorama/scope-label";

import { PanoramaDockRegistros } from "../PanoramaDockRegistros";

const SINCE = new Date("2026-04-01T00:00:00Z");
const UNTIL = new Date("2026-06-30T00:00:00Z");

const CABA_LOCALITIES = [
  { slug: "palermo", name: "Palermo" },
  { slug: "recoleta", name: "Recoleta" },
  { slug: "caballito", name: "Caballito" },
  { slug: "flores", name: "Flores" },
  { slug: "boedo", name: "Boedo" },
];

const CABA_JURISDICTIONS = CABA_LOCALITIES.map((l) => ({ province: "CABA", locality: l.name }));

/**
 * Reproduce the console's caption chain end to end: the server label the page
 * computes from the operator's ROLE + assigned jurisdictions, the live label the
 * client derives from the drill, the cascade that picks between them, and the
 * caption composed from the winner. Every link is a production function — a test
 * that hardcoded the middle could not have caught the bug described below.
 */
function captionFor(input: {
  role: string;
  jurisdictions: Array<{ province: string; locality: string }>;
  province?: string | null;
  locality?: string | null;
}): string {
  const province = input.province ?? null;
  const locality = input.locality ?? null;
  const states = initialState();
  // desierto-veterinario is a temporal layer, so the period label stays a window
  // ("últimos 90 días") instead of collapsing to "estado actual".
  states["desierto-veterinario"] = { ...states["desierto-veterinario"], active: true };
  const view = buildViewMeta({
    province,
    locality,
    since: SINCE,
    until: UNTIL,
    periodParam: "90d",
    states,
    asOf: null,
  });
  const live = deriveLiveScopeLabel({
    province,
    locality,
    serverScopeLabel: panoramaScopeLabel(input.role, input.jurisdictions),
    allowedProvinces: [{ code: "AR-C", name: "CABA" }],
    localities: CABA_LOCALITIES,
  });
  return buildMapTableCaption(resolveScopeLabel(live, view.scopeLabel), view.periodLabel);
}

function summary(over: Partial<DockRecordSummary> = {}): DockRecordSummary {
  return {
    hasCountLayer: true,
    total: 3026,
    suppressed: 0,
    unitsWithEvents: 18,
    anyPeriodLayer: true,
    ...over,
  };
}

function render(
  over: { summary?: DockRecordSummary; caption?: string; rows?: MapTableRow[] } = {},
): string {
  return renderToStaticMarkup(
    <PanoramaDockRegistros
      summary={over.summary ?? summary()}
      referenceLayerLabels={[]}
      localityRateInView={false}
      rows={over.rows ?? []}
      caption={over.caption ?? captionFor({ role: "admin", jurisdictions: [] })}
      metrics={[]}
      truncatedLayers={[]}
      pointModeLayerLabels={[]}
      suppressedUnits={0}
      viewScope={null}
    />,
  );
}

// QA 2026-08-01, government sanitary-authority walkthrough. The caption read
// `buildViewMeta`'s scope label directly, and that label answers "is the VIEW
// filtered?", not "what may this OPERATOR see?" — with no drill it says
// "Nacional" for everyone. A CABA-bounded account therefore titled its Registros
// table "Datos del mapa por unidad — Nacional, últimos 90 días." over five
// localities' worth of rows. A decisor who notices that stops believing the
// table, and then the board.
//
// This suite previously PINNED that exact string: the caption arrived as a
// hardcoded `caption="Datos del mapa por unidad — Nacional, últimos 90 días."`
// fixture, so the lie was the suite's own baseline and no assertion could ever
// reach it. The cases below compose the caption through the real chain, per ROLE.
describe("Registros caption — the scope it names is the scope the operator has", () => {
  it("names the bounded jurisdiction, not the nation, for a govt operator with no drill", () => {
    const caption = captionFor({ role: "govt", jurisdictions: CABA_JURISDICTIONS });
    expect(caption).toBe("Datos del mapa por unidad — CABA · 5 localidades, últimos 90 días.");
  });

  it("names the drilled locality once the operator drills into one", () => {
    const caption = captionFor({
      role: "govt",
      jurisdictions: CABA_JURISDICTIONS,
      province: "AR-C",
      locality: "palermo",
    });
    expect(caption).toContain("CABA · Palermo");
    expect(caption).not.toContain("5 localidades");
  });

  // The case that keeps the fix honest in the other direction: "Nacional" is not
  // a bug word. For an admin (universal scope, no drill) it is the true answer,
  // and a fix that scrubbed it everywhere would have broken /admin/panorama.
  it("still says Nacional for an admin with no drill — for admin that is CORRECT", () => {
    expect(captionFor({ role: "admin", jurisdictions: [] })).toBe(
      "Datos del mapa por unidad — Nacional · todas las provincias, últimos 90 días.",
    );
  });

  it("renders the composed caption onto the surface that shows it", () => {
    // LA COSTURA SE MOVIÓ, NO LA PROPIEDAD (Lote E paso 2, 2026-08-10).
    //
    // Antes esto renderizaba el PANE y buscaba la copia. Desde que MapDataTable
    // entra por next/dynamic, el primer frame del pane es el placeholder, así
    // que `renderToStaticMarkup` sobre el pane ya no puede ver la leyenda —
    // devolvería un verde vacío o un rojo por el motivo equivocado.
    //
    // Lo que importa sigue siendo lo mismo y sigue probado acá: la cadena de
    // caption compuesta para un funcionario nombra SU alcance y no "Nacional"
    // (el bug real que este bloque existe para impedir), y esa cadena llega
    // efectivamente al DOM. Se afirma sobre el componente que la pinta.
    const caption = captionFor({ role: "govt", jurisdictions: CABA_JURISDICTIONS });
    const html = renderToStaticMarkup(
      <MapDataTable
        rows={[{ layer: "Desierto veterinario", unit: "Palermo", value: "12" }]}
        caption={caption}
        filename="panorama-mapa"
        metrics={[]}
        truncatedLayers={[]}
      />,
    );
    expect(html).toContain("CABA · 5 localidades");
    expect(html).not.toContain("Nacional");
  });

  it("el pane monta la tabla detrás de una frontera perezosa, y la anuncia", () => {
    // El complemento del test de arriba: acá se prueba que el pane SÍ pone la
    // tabla, aunque su contenido llegue después. Sin esto, borrar
    // MapDataTableDynamic del pane no rompería nada.
    const html = render({
      caption: captionFor({ role: "govt", jurisdictions: CABA_JURISDICTIONS }),
      rows: [{ layer: "Desierto veterinario", unit: "Palermo", value: "12" }],
    });
    expect(html).toContain("Cargando la tabla de registros");
    expect(html, "el placeholder declara que está ocupado").toContain('aria-busy="true"');
  });
});

describe("PanoramaDockRegistros — the event total names what it counts", () => {
  it("labels a period-flow total as events in the period", () => {
    expect(render()).toContain("Eventos en el período");
  });

  it("labels a current-state stock as 'Registros (estado actual)', never as period events", () => {
    expect(render({ summary: summary({ anyPeriodLayer: false }) })).toContain(
      "Registros (estado actual)",
    );
  });

  // RA-7 F6 — the console answered "cuántas celdas están protegidas" in four
  // places at once. Two of them were one claim computed twice (fixed by
  // `activeSuppressedCells`); the other two, including this one, are genuinely
  // NARROWER universes. A narrower number is fine — a narrower number that does
  // not say what it counts is a contradiction of the legend pill's view-wide
  // total sitting a few centimetres away.
  it("says the protected units are EXCLUDED FROM THIS TOTAL, not that they are the view's", () => {
    const html = render({ summary: summary({ suppressed: 4 }) });
    expect(html).toContain("4 unidades protegidas por k-anonimato, no incluidas en este total");
  });

  it("keeps the singular honest too", () => {
    const html = render({ summary: summary({ suppressed: 1 }) });
    expect(html).toContain("1 unidad protegida por k-anonimato, no incluida en este total");
  });

  it("says nothing about protection when nothing was withheld", () => {
    expect(render()).not.toContain("k-anonimato");
  });
});
