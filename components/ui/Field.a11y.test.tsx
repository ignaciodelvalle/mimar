// @vitest-environment jsdom
//
// LnField label↔input association (WCAG 1.3.1 / 3.3.2 / 4.1.2). The wrapper
// must guarantee that:
//   - the <label> htmlFor matches the control id (screen reader announces the
//     label; clicking the label focuses the control),
//   - the association holds even when a caller forgets to wire id={id},
//   - required fields expose aria-required and errored fields aria-invalid to
//     assistive tech (not only via the visual asterisk / red border).

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LnField, LnInput } from "./Field";

describe("LnField label↔input association", () => {
  it("wires htmlFor on the label to the id the render-prop provides", () => {
    const { container } = render(
      <LnField label="Nombre">
        {({ id, describedBy, invalid }) => (
          <LnInput id={id} name="name" aria-describedby={describedBy} invalid={invalid} />
        )}
      </LnField>,
    );

    const label = container.querySelector("label") as HTMLLabelElement;
    const input = container.querySelector("input") as HTMLInputElement;
    expect(label.htmlFor).toBeTruthy();
    expect(label.htmlFor).toBe(input.id);
  });

  it("associates label↔input even when the caller forgets to wire id={id}", () => {
    const { container } = render(
      <LnField label="Apellido">
        {/* Intentionally omit id={id} — the wrapper must still associate them. */}
        {() => <LnInput name="lastName" />}
      </LnField>,
    );

    const label = container.querySelector("label") as HTMLLabelElement;
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.id).toBeTruthy();
    expect(label.htmlFor).toBe(input.id);
  });

  it("exposes aria-required on required fields", () => {
    const { container } = render(
      <LnField label="Especie" required>
        {() => <LnInput name="species" />}
      </LnField>,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.getAttribute("aria-required")).toBe("true");
  });

  it("exposes aria-invalid when the field carries an error", () => {
    const { container } = render(
      <LnField label="Email" error="Ingresá un email válido.">
        {() => <LnInput name="email" />}
      </LnField>,
    );
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("does not override a caller-supplied explicit id", () => {
    const { container } = render(
      <LnField label="Chip">{() => <LnInput id="explicit-chip-id" name="chip" />}</LnField>,
    );
    const label = container.querySelector("label") as HTMLLabelElement;
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.id).toBe("explicit-chip-id");
    expect(label.htmlFor).toBe("explicit-chip-id");
  });
});
