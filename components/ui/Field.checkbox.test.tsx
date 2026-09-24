// Smoke tests for LnCheckbox and LnRadio.
//
// Same renderToStaticMarkup pattern used across the project's component tests.
// No jsdom needed: assertions target server-renderable HTML contracts.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnCheckbox } from "./Field";
import { LnRadio } from "./Field";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe("<LnCheckbox>", () => {
  it("wraps the label in a <label htmlFor> that matches the input id", () => {
    const html = render(<LnCheckbox name="terms">Acepto los términos</LnCheckbox>);
    const labelMatch = html.match(/<label[^>]*for="([^"]+)"/);
    const inputMatch = html.match(/<input[^>]*id="([^"]+)"/);
    expect(labelMatch).not.toBeNull();
    expect(inputMatch).not.toBeNull();
    expect(labelMatch?.[1]).toBe(inputMatch?.[1]);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Acepto los términos");
  });

  it("respects an explicit id over the auto-generated one", () => {
    const html = render(
      <LnCheckbox id="my-terms" name="terms">
        Acepto
      </LnCheckbox>,
    );
    expect(html).toMatch(/id="my-terms"/);
    expect(html).toMatch(/for="my-terms"/);
  });

  it("emits aria-invalid when invalid", () => {
    const html = render(
      <LnCheckbox name="terms" invalid>
        Acepto
      </LnCheckbox>,
    );
    expect(html).toMatch(/aria-invalid="true"/);
  });

  it("forwards name, value, required, and defaultChecked to the input", () => {
    const html = render(
      <LnCheckbox name="vaccines" value="rabies" required defaultChecked>
        Antirrábica
      </LnCheckbox>,
    );
    expect(html).toContain('name="vaccines"');
    expect(html).toContain('value="rabies"');
    expect(html).toMatch(/\brequired(\s|=|>|\/)/);
    // renderToStaticMarkup serialises defaultChecked as checked=""
    expect(html).toMatch(/\bchecked(\s|=|>|\/)/);
  });

  it("renders label-less (no <label> wrapper) when children is omitted, keeping aria-label", () => {
    const html = render(<LnCheckbox name="row" aria-label="Seleccionar fila" />);
    expect(html).not.toContain("<label");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-label="Seleccionar fila"');
  });

  it("contains an ln-* token class (accent-[var(--color-ln-azul)])", () => {
    const html = render(<LnCheckbox name="t">Label</LnCheckbox>);
    expect(html).toContain("ln-azul");
  });

  it("contains zero gob- substrings", () => {
    const html = render(<LnCheckbox name="t">Label</LnCheckbox>);
    expect(html).not.toContain("gob-");
  });

  it("applies error outline class when invalid", () => {
    const html = render(
      <LnCheckbox name="t" invalid>
        Label
      </LnCheckbox>,
    );
    expect(html).toContain("ln-err");
  });
});

describe("<LnRadio>", () => {
  it("renders type=radio and a matched label", () => {
    const html = render(
      <LnRadio name="procedure" value="castration">
        Castración
      </LnRadio>,
    );
    expect(html).toContain('type="radio"');
    expect(html).toContain("Castración");
    const labelMatch = html.match(/<label[^>]*for="([^"]+)"/);
    const inputMatch = html.match(/<input[^>]*id="([^"]+)"/);
    expect(labelMatch?.[1]).toBe(inputMatch?.[1]);
  });

  it("renders label-less (no <label> wrapper) when children is omitted", () => {
    const html = render(<LnRadio name="row" value="a" aria-label="Opción A" />);
    expect(html).not.toContain("<label");
    expect(html).toContain('type="radio"');
    expect(html).toContain('aria-label="Opción A"');
  });

  it("two radios with the same name have distinct ids", () => {
    const html = render(
      <>
        <LnRadio name="procedure" value="castration">
          Castración
        </LnRadio>
        <LnRadio name="procedure" value="spay">
          Ovariectomía
        </LnRadio>
      </>,
    );
    const ids = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect((html.match(/name="procedure"/g) ?? []).length).toBe(2);
  });

  it("emits aria-invalid when invalid", () => {
    const html = render(
      <LnRadio name="p" value="a" invalid>
        Opción A
      </LnRadio>,
    );
    expect(html).toMatch(/aria-invalid="true"/);
  });

  it("contains an ln-* token class (accent-[var(--color-ln-azul)])", () => {
    const html = render(
      <LnRadio name="p" value="a">
        Opción
      </LnRadio>,
    );
    expect(html).toContain("ln-azul");
  });

  it("contains zero gob- substrings", () => {
    const html = render(
      <LnRadio name="p" value="a">
        Opción
      </LnRadio>,
    );
    expect(html).not.toContain("gob-");
  });
});
