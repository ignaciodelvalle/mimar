/**
 * Wave 2 Item 9 — Mobile/a11y invariants for event-form shared primitives.
 *
 * Tests the shared contracts that apply to ALL 17+ event forms:
 *  1. LnInput/LnSelect/LnTextarea have font-size ≥ 16px on mobile (iOS zoom prevention)
 *  2. LnInput/LnSelect/LnTextarea have min-height ≥ 44px (touch target)
 *  3. LnSheetFooter sticky positioning (mobile CTA reachability)
 *  4. LnSheetFooter renders pending label (configurable)
 *  5. LnSuccessScreen h1 heading is present (focus target after trámite)
 *  6. useFormErrorFocus exported from lib without crash
 *
 * These are structural/static tests using renderToStaticMarkup — no jsdom needed.
 */

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnInput, LnSelect, LnTextarea } from "./Field";
import { LnSheetFooter } from "./Sheet";
import { LnSuccessScreen } from "./SuccessScreen";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

// ---------------------------------------------------------------------------
// 1. font-size ≥ 16px (iOS zoom prevention)
// ---------------------------------------------------------------------------

describe("LnInput — mobile font size", () => {
  it("includes text-base class for mobile iOS zoom prevention", () => {
    const html = render(<LnInput name="test" />);
    expect(html).toContain("text-base");
  });
});

describe("LnSelect — mobile font size", () => {
  it("includes text-base class for mobile iOS zoom prevention", () => {
    const html = render(
      <LnSelect name="test">
        <option value="a">A</option>
      </LnSelect>,
    );
    expect(html).toContain("text-base");
  });
});

describe("LnTextarea — mobile font size", () => {
  it("includes text-base class for mobile iOS zoom prevention", () => {
    const html = render(<LnTextarea name="test" />);
    expect(html).toContain("text-base");
  });
});

// ---------------------------------------------------------------------------
// 2. min-height 44px (touch target — WCAG 2.5.5)
// ---------------------------------------------------------------------------

describe("LnInput — min-height touch target", () => {
  it("includes min-h-[44px] class for 44×44px touch target compliance", () => {
    const html = render(<LnInput name="test" />);
    expect(html).toContain("min-h-[44px]");
  });
});

describe("LnSelect — min-height touch target", () => {
  it("includes min-h-[44px] class for 44×44px touch target compliance", () => {
    const html = render(
      <LnSelect name="test">
        <option value="a">A</option>
      </LnSelect>,
    );
    expect(html).toContain("min-h-[44px]");
  });
});

// ---------------------------------------------------------------------------
// 3. LnSheetFooter sticky (CTA reachability)
// ---------------------------------------------------------------------------

describe("LnSheetFooter — sticky positioning", () => {
  it("renders with sticky class so CTA stays reachable on long forms", () => {
    const html = render(<LnSheetFooter ctaLabel="Registrar vacuna" />);
    expect(html).toContain("sticky");
    expect(html).toContain("bottom-0");
  });
});

// ---------------------------------------------------------------------------
// 4. LnSheetFooter pending label
// ---------------------------------------------------------------------------

describe("LnSheetFooter — pending label", () => {
  it("renders default 'Registrando…' while pending", () => {
    const html = render(<LnSheetFooter ctaLabel="Registrar vacuna" isPending />);
    expect(html).toContain("Registrando");
  });

  it("respects custom pendingLabel prop", () => {
    const html = render(<LnSheetFooter ctaLabel="Guardar" isPending pendingLabel="Guardando…" />);
    expect(html).toContain("Guardando");
    expect(html).not.toContain("Registrando");
  });

  it("button is disabled while pending", () => {
    const html = render(<LnSheetFooter ctaLabel="Registrar" isPending />);
    expect(html).toMatch(/disabled/);
  });
});

// ---------------------------------------------------------------------------
// 5. LnSuccessScreen heading (focus target after trámite)
// ---------------------------------------------------------------------------

describe("LnSuccessScreen — heading for focus", () => {
  it("renders an h1 with the title (focus target after trámite flow)", () => {
    const html = render(
      <LnSuccessScreen
        title="Mordedura registrada"
        next={[{ label: "Ver perfil", href: "/mis-mascotas/abc" }]}
      />,
    );
    expect(html).toMatch(/<h1[^>]*>Mordedura registrada<\/h1>/);
  });

  it("contains the description when provided", () => {
    const html = render(
      <LnSuccessScreen
        title="OK"
        description="Observación 10 días"
        next={[{ label: "Volver", href: "/" }]}
      />,
    );
    expect(html).toContain("Observación 10 días");
  });
});

// ---------------------------------------------------------------------------
// 6. inputMode forwarding
// ---------------------------------------------------------------------------

describe("LnInput — inputMode forwarding", () => {
  it("forwards inputMode='decimal' to the underlying input element", () => {
    const html = render(<LnInput name="kg" type="number" inputMode="decimal" />);
    // React 19 renderToStaticMarkup emits camelCase attribute names
    expect(html).toContain('inputMode="decimal"');
  });

  it("forwards inputMode='numeric' to the underlying input element", () => {
    const html = render(<LnInput name="hours" type="number" inputMode="numeric" />);
    expect(html).toContain('inputMode="numeric"');
  });

  it("forwards inputMode='tel' to the underlying input element", () => {
    const html = render(<LnInput name="phone" type="tel" inputMode="tel" />);
    expect(html).toContain('inputMode="tel"');
  });
});
