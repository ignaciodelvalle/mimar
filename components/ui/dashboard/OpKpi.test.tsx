// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DELTA_IMPLAUSIBLE_NOTE,
  DELTA_IMPLAUSIBLE_SUFFIX,
  UNSTABLE_DELTA_BASE_NOTE,
} from "@/lib/metrics/presentation-guards";
import { OpKpi } from "./OpKpi";

// Regression — Cowork B6: on /gob/programa the KPI tiles wrap the whole card in
// an <a href>. The ⓘ info button is a DESCENDANT of that anchor, so a click on
// it used to trigger the anchor's native navigation instead of opening the
// tooltip. The fix calls e.preventDefault() (not just stopPropagation) in the
// button handler so the ancestor <a>'s default navigation is cancelled.
describe("OpKpi — ⓘ inside an href-wrapped tile", () => {
  const info = {
    definition: "Qué mide este indicador.",
    formula: "a / b × 100",
    caveat: "Se suprimen celdas con menos de 5 casos.",
  };

  afterEach(cleanup);

  it("clicking ⓘ opens the tooltip and does NOT navigate the tile link", () => {
    render(<OpKpi label="Cobertura" value="64,3%" href="/gob/poblacion" info={info} />);

    const infoBtn = screen.getByRole("button", { name: /Información sobre este indicador/i });

    // fireEvent returns false when the handler called preventDefault — i.e.
    // the ancestor <a>'s native navigation was cancelled.
    expect(fireEvent.click(infoBtn)).toBe(false);

    // …and the tooltip content is now visible.
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.getByText("Qué mide este indicador.")).toBeTruthy();
  });

  it("the backdrop dismiss click also cancels navigation", () => {
    render(<OpKpi label="Cobertura" value="64,3%" href="/gob/poblacion" info={info} />);

    fireEvent.click(screen.getByRole("button", { name: /Información sobre este indicador/i }));
    const backdrop = screen.getByRole("button", { name: /Cerrar información/i });

    expect(fireEvent.click(backdrop)).toBe(false);
  });

  // PO directive (no loose glyphs/emojis): the ⓘ literal is retired in favour of
  // the app's Icon registry. The trigger must render the registry `info` glyph,
  // not a bare unicode character.
  it("renders the ⓘ trigger through the Icon registry, not a literal glyph", () => {
    const { container } = render(<OpKpi label="Cobertura" value="64,3%" info={info} />);
    const trigger = screen.getByRole("button", { name: /Información sobre este indicador/i });
    expect(trigger.querySelector('[data-icon-name="info"]')).toBeTruthy();
    expect(container.textContent ?? "").not.toContain("ⓘ");
  });

  // A 390px sweep of the operator screens counted 58 tap targets under 24px,
  // and most of them were THIS button repeated once per KPI — the glyph is
  // 14×14 and the button had no padding. The fix is the hit-area extension
  // already used by .lp-hcard-flip::after: the visual stays 14px, an invisible
  // ::after pads the target to 24×24.
  //
  // WHAT THIS TEST CAN AND CANNOT PROVE. jsdom does no layout and does not
  // resolve ::after boxes, so it cannot measure 24px — asserting a computed
  // size here would be theatre. It pins the HOOK instead: the class that
  // carries the extension must stay on the trigger, because dropping it
  // returns the target to 14×14 with no visual change to catch in review. That
  // the class itself still has a rule behind it is pinned separately, in
  // __tests__/hit-area-utility.test.ts, against globals.css.
  it("keeps the ⓘ hit-area extension — the glyph is 14px, the target must not be", () => {
    render(<OpKpi label="Cobertura" value="64,3%" info={info} />);
    const trigger = screen.getByRole("button", { name: /Información sobre este indicador/i });
    expect(trigger.className).toContain("op-hit-24");
  });
});

// Track B (dashboards milestone) — legibility / honesty.
describe("OpKpi — stock-vs-flow framing is DERIVED from the contract", () => {
  afterEach(cleanup);

  const NOTE = /no varía con el período/i;

  it("tags a point-in-time stock without the caller remembering to", () => {
    // open_welfare_reports is basis:"stock", window:"now" in the catalog. A
    // stock under a period picker "lies by proximity" — the control implies it
    // moves the number and it does not. 181 call sites cannot be trusted to
    // remember that; the contract already knows it.
    render(<OpKpi label="Denuncias abiertas" value="42" descriptorId="open_welfare_reports" />);
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it("leaves a flow metric alone — the period control DOES move it", () => {
    render(<OpKpi label="Esterilizaciones" value="120" descriptorId="sterilizations_per_month" />);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("does not tag a tile with no descriptor (the grandfathered majority)", () => {
    render(<OpKpi label="Algo" value="7" />);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it("an explicit periodInvariant={false} still wins over the derivation", () => {
    render(
      <OpKpi
        label="Denuncias abiertas"
        value="42"
        descriptorId="open_welfare_reports"
        periodInvariant={false}
      />,
    );
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});

describe("OpKpi — the delta names its base, and 'Normal' stays quiet", () => {
  afterEach(cleanup);

  it("shows the prior-period base so a percentage is checkable", () => {
    render(
      <OpKpi
        label="Casos"
        value="3.021"
        deltaV2={{ value: 139, period: "vs mes anterior" }}
        guardInput={{ priorBase: 1263 }}
      />,
    );
    // A bare "+139%" is a press figure; naming the base makes it auditable.
    expect(screen.getByText(/desde 1\.263/)).toBeTruthy();
  });

  it("omits the base when the caller has no prior count to show", () => {
    render(
      <OpKpi label="Casos" value="3.021" deltaV2={{ value: 139, period: "vs mes anterior" }} />,
    );
    expect(screen.queryByText(/desde/)).toBeNull();
  });

  // Track B asked to kill the "Normal:" leak. The first fix DELETED the ok
  // label, which removed the tone's only text equivalent — the glyph is
  // aria-hidden, so that left COLOUR ALONE carrying the state (WCAG 1.4.1).
  // __tests__/a11y-badge-kpi.test.tsx caught it. The leak was the ORDER, not
  // the existence: the state preempted the metric name on every tile.
  it("announces every tone — the glyph is aria-hidden, so text is the only cue", () => {
    for (const [tone, word] of [
      ["danger", "Peligro"],
      ["warn", "Atención"],
      ["ok", "Normal"],
    ] as const) {
      const { container } = render(<OpKpi label="Vencidos" value="9" tone={tone} />);
      expect(container.textContent).toContain(word);
      cleanup();
    }
  });

  it("puts the state AFTER the label, so the metric is heard first", () => {
    const { container } = render(<OpKpi label="Al día" value="9" tone="ok" />);
    const text = container.textContent ?? "";
    // Both present, label first — the regression was "Normal: Al día".
    expect(text.indexOf("Al día")).toBeGreaterThan(-1);
    expect(text.indexOf("Normal")).toBeGreaterThan(text.indexOf("Al día"));
  });

  it("stays silent when there is no tone to announce", () => {
    const { container } = render(<OpKpi label="Total" value="9" />);
    expect(container.textContent).not.toContain("Normal");
  });
});

// ---------------------------------------------------------------------------
// H16 (external red-team 2026-07-30) — the implausible delta.
//
// WHAT SHIPPED: /gob's "Esterilizaciones / mes" tile rendered
// "1 ↓ −99,6% vs mes anterior (desde 274)" in the SAME red a genuine collapse
// gets. The prior base was 274, comfortably above unstableDeltaBase's floor of
// 5, so the only guard that could have caught it had no reason to fire. A
// funcionario who repeats that figure in a meeting is repeating an incomplete
// load as a fact.
//
// The fix withholds the VERDICT, not the number: value, sign, arrow and prior
// base all still render. These tests pin both halves — that the number
// survives, and that the colour does not.
// ---------------------------------------------------------------------------

/** The delta chip's own row (the element carrying the valence colour). The
 *  period text is a descendant span, and spans are never `div`s, so the
 *  closest div ancestor is the row DeltaV2Row builds. */
function deltaRow(): HTMLElement {
  const el = screen.getByText(/vs mes ant\./).closest("div");
  if (el === null) throw new Error("delta row not found");
  return el as HTMLElement;
}

describe("OpKpi — an order-of-magnitude delta loses its verdict, not its number", () => {
  afterEach(cleanup);

  const LIVE_DELTA = { value: -99.6, period: "vs mes ant." } as const;

  it("renders the flagged delta muted, and an unflagged one of the same shape red", () => {
    // Guarded: the catalogued descriptor + a healthy prior base.
    render(
      <OpKpi
        label="Esterilizaciones / mes"
        value="1"
        deltaV2={LIVE_DELTA}
        descriptorId="sterilizations_per_month"
        guardInput={{ priorBase: 274 }}
      />,
    );
    expect(deltaRow().className).toContain("text-ln-op-mute");
    cleanup();

    // CONTROL, same delta, no descriptor → the ordinary bad-news treatment.
    // This is what keeps the assertion above from decaying into a tautology if
    // the token names ever change: the pair can only both pass while the two
    // treatments are genuinely different.
    render(<OpKpi label="Esterilizaciones / mes" value="1" deltaV2={LIVE_DELTA} />);
    expect(deltaRow().className).toContain("--color-st-err");
  });

  it("keeps the figure, the direction and the base fully visible", () => {
    const { container } = render(
      <OpKpi
        label="Esterilizaciones / mes"
        value="1"
        deltaV2={LIVE_DELTA}
        descriptorId="sterilizations_per_month"
        guardInput={{ priorBase: 274 }}
      />,
    );
    const text = container.textContent ?? "";
    // es-AR separator. This assertion used to read "99.6" — an English decimal
    // point, which was the delta row printing `{delta.value}` as a raw JS
    // number while every other figure in the tile went through the es-AR
    // formatters. The file's own header describes this very case as "−99,6%
    // desde 274", so the test contradicted its source. Asserting the comma is
    // what keeps the raw-interpolation regression from coming back.
    expect(text).toContain("-99,6%");
    expect(text).toContain("desde 274");
    expect(screen.getByText("↓")).toBeTruthy();
  });

  it("says what to do about it, on the chip and in the guard note", () => {
    const { container } = render(
      <OpKpi
        label="Esterilizaciones / mes"
        value="1"
        deltaV2={LIVE_DELTA}
        descriptorId="sterilizations_per_month"
        guardInput={{ priorBase: 274 }}
      />,
    );
    expect(container.textContent).toContain(DELTA_IMPLAUSIBLE_SUFFIX);
    expect(screen.getByText(DELTA_IMPLAUSIBLE_NOTE)).toBeTruthy();
  });

  it("leaves a real, plausible drop fully red — the guard must not eat true alarms", () => {
    render(
      <OpKpi
        label="Esterilizaciones / mes"
        value="164"
        deltaV2={{ value: -40, period: "vs mes ant." }}
        descriptorId="sterilizations_per_month"
        guardInput={{ priorBase: 274 }}
      />,
    );
    expect(deltaRow().className).toContain("--color-st-err");
    expect(screen.queryByText(DELTA_IMPLAUSIBLE_NOTE)).toBeNull();
  });

  it("leaves a legitimate near-doubling green — +95% is not an order of magnitude", () => {
    render(
      <OpKpi
        label="Esterilizaciones / mes"
        value="534"
        deltaV2={{ value: 95, period: "vs mes ant." }}
        descriptorId="sterilizations_per_month"
        guardInput={{ priorBase: 274 }}
      />,
    );
    expect(deltaRow().className).toContain("--color-st-ok");
    expect(screen.queryByText(DELTA_IMPLAUSIBLE_NOTE)).toBeNull();
  });

  it("defers to the unstable-base guard below its floor — one note, not two", () => {
    const { container } = render(
      <OpKpi
        label="Esterilizaciones / mes"
        value="0"
        deltaV2={{ value: -100, period: "vs mes ant." }}
        descriptorId="sterilizations_per_month"
        guardInput={{ priorBase: 3 }}
      />,
    );
    // The older guard drops the chip entirely, so there is no chip left to
    // annotate — asserting on its note (a positive claim) also pins that the
    // two guards did not both fire.
    expect(screen.getByText(UNSTABLE_DELTA_BASE_NOTE)).toBeTruthy();
    expect(container.textContent).not.toContain(DELTA_IMPLAUSIBLE_SUFFIX);
  });
});

// Provenance ("¿De dónde sale este número?") — the "Ver origen" affordance at
// the ⓘ popover's foot is gated on descriptorId: a catalogued tile gets it, a
// descriptor-less tile never does.
describe("OpKpi — 'Ver origen' is gated on descriptorId", () => {
  afterEach(cleanup);

  const info = {
    definition: "Qué mide este indicador.",
    formula: "a / b × 100",
  };

  it("shows the link for a catalogued tile and opens the provenance dialog", () => {
    // jsdom lacks <dialog>.showModal — stub it (ConfirmDialog.test idiom).
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };

    render(
      <OpKpi
        label="Cobertura"
        value="64,3%"
        href="/gob/poblacion"
        info={info}
        descriptorId="rabies_coverage_dogs_12m"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Información sobre este indicador/i }));
    const verOrigen = screen.getByRole("button", { name: "Ver origen" });

    // Same anchor-descendant hazard as the ⓘ trigger: the click must cancel
    // the wrapping <a>'s native navigation.
    expect(fireEvent.click(verOrigen)).toBe(false);
    expect(screen.getByText("Origen del dato")).toBeTruthy();
    expect(screen.getByText(/Perros del padrón con al menos una vacuna antirrábica/)).toBeTruthy();
  });

  it("renders NO link when the tile has no descriptor", () => {
    render(<OpKpi label="Cobertura" value="64,3%" info={info} />);
    fireEvent.click(screen.getByRole("button", { name: /Información sobre este indicador/i }));
    expect(screen.queryByRole("button", { name: "Ver origen" })).toBeNull();
    expect(screen.queryByText("Origen del dato")).toBeNull();
  });
});
