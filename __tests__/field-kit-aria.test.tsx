/**
 * Unit tests for UX 1.5 — field kit aria linkage.
 *
 * Verifies that LnField and OpField:
 *  - generate a stable id and pass it to the render-prop as `id`
 *  - set aria-describedby on the control pointing at the rendered error element
 *  - set aria-invalid on the control when an error is present
 *  - do NOT set aria-invalid or aria-describedby (error) when there is no error
 *  - show the required asterisk and (LnField only) auto-inject aria-required
 *    onto the render-prop's control, so callers don't have to wire it by hand
 *
 * Pattern: renderToStaticMarkup — repo convention; no jsdom required.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { OpField } from "@/components/ui/dashboard/OpField";

// ---------------------------------------------------------------------------
// LnField
// ---------------------------------------------------------------------------

describe("LnField — aria linkage", () => {
  it("passes a non-empty id to the render-prop", () => {
    let capturedId = "";
    renderToStaticMarkup(
      <LnField label="Email">
        {({ id }) => {
          capturedId = id;
          return <LnInput id={id} />;
        }}
      </LnField>,
    );
    expect(capturedId).toBeTruthy();
  });

  it("renders the control with the id exposed by the render-prop", () => {
    const html = renderToStaticMarkup(
      <LnField label="Email">
        {({ id, describedBy, invalid }) => (
          <LnInput id={id} aria-describedby={describedBy} invalid={invalid} />
        )}
      </LnField>,
    );
    // The label's htmlFor and the input's id must match (same id token).
    const labelMatch = html.match(/for="([^"]+)"/);
    const inputMatch = html.match(/id="([^"]+)"/);
    expect(labelMatch).not.toBeNull();
    expect(inputMatch).not.toBeNull();
    expect(labelMatch![1]).toBe(inputMatch![1]);
  });

  it("sets aria-invalid on the control when error is present", () => {
    const html = renderToStaticMarkup(
      <LnField label="Email" error="Correo inválido">
        {({ id, describedBy, invalid }) => (
          <LnInput id={id} aria-describedby={describedBy} invalid={invalid} />
        )}
      </LnField>,
    );
    expect(html).toContain('aria-invalid="true"');
  });

  it("does NOT set aria-invalid when no error", () => {
    const html = renderToStaticMarkup(
      <LnField label="Email">
        {({ id, describedBy, invalid }) => (
          <LnInput id={id} aria-describedby={describedBy} invalid={invalid} />
        )}
      </LnField>,
    );
    expect(html).not.toContain("aria-invalid");
  });

  it("sets aria-describedby pointing at the error element id when error is present", () => {
    let capturedDescribedBy: string | undefined;
    const html = renderToStaticMarkup(
      <LnField label="Email" error="Correo inválido">
        {({ id, describedBy, invalid }) => {
          capturedDescribedBy = describedBy;
          return <LnInput id={id} aria-describedby={describedBy} invalid={invalid} />;
        }}
      </LnField>,
    );
    expect(capturedDescribedBy).toBeTruthy();
    // The error paragraph must carry that id.
    expect(html).toContain(`id="${capturedDescribedBy}"`);
    // The input must reference it via aria-describedby.
    expect(html).toContain(`aria-describedby="${capturedDescribedBy}"`);
  });

  it("does NOT emit aria-describedby when there is no error and no hint", () => {
    const html = renderToStaticMarkup(
      <LnField label="Email">
        {({ id, describedBy, invalid }) => (
          <LnInput id={id} aria-describedby={describedBy} invalid={invalid} />
        )}
      </LnField>,
    );
    expect(html).not.toContain("aria-describedby");
  });

  it("sets aria-describedby pointing at the hint element when hint present and no error", () => {
    let capturedDescribedBy: string | undefined;
    const html = renderToStaticMarkup(
      <LnField label="DNI" hint="Podés agregarlo después.">
        {({ id, describedBy, invalid }) => {
          capturedDescribedBy = describedBy;
          return <LnInput id={id} aria-describedby={describedBy} invalid={invalid} />;
        }}
      </LnField>,
    );
    expect(capturedDescribedBy).toBeTruthy();
    expect(html).toContain(`id="${capturedDescribedBy}"`);
    expect(html).toContain("Podés agregarlo después.");
  });

  it("renders the required asterisk when required=true", () => {
    const html = renderToStaticMarkup(
      <LnField label="Contraseña" required>
        {({ id }) => <LnInput id={id} />}
      </LnField>,
    );
    expect(html).toContain("*");
  });

  it("does NOT render the required asterisk when required is not set", () => {
    const html = renderToStaticMarkup(
      <LnField label="DNI">{({ id }) => <LnInput id={id} />}</LnField>,
    );
    // The asterisk span should not be present (optional label may render "opcional" text)
    expect(html).not.toContain('class="text-[var(--color-ln-seal)]"');
  });

  it("sets aria-required on the control when required=true (WCAG 3.3.2)", () => {
    const html = renderToStaticMarkup(
      <LnField label="Contraseña" required>
        {({ id }) => <LnInput id={id} />}
      </LnField>,
    );
    expect(html).toContain('aria-required="true"');
  });

  it("does NOT set aria-required when required is not set", () => {
    const html = renderToStaticMarkup(
      <LnField label="DNI">{({ id }) => <LnInput id={id} />}</LnField>,
    );
    expect(html).not.toContain("aria-required");
  });

  it("sets aria-required on LnSelect too, without the caller wiring it by hand", () => {
    const html = renderToStaticMarkup(
      <LnField label="Severidad" required>
        {({ id }) => (
          <LnSelect id={id}>
            <option value="minor">Leve</option>
          </LnSelect>
        )}
      </LnField>,
    );
    expect(html).toContain('aria-required="true"');
  });

  it("LnField works the same with LnSelect", () => {
    const html = renderToStaticMarkup(
      <LnField label="Severidad" required error="Requerido">
        {({ id, describedBy, invalid }) => (
          <LnSelect id={id} aria-describedby={describedBy} invalid={invalid}>
            <option value="minor">Leve</option>
          </LnSelect>
        )}
      </LnField>,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("aria-describedby=");
  });

  it("LnField works the same with LnTextarea", () => {
    const html = renderToStaticMarkup(
      <LnField label="Contexto" error="Campo requerido">
        {({ id, describedBy, invalid }) => (
          <LnTextarea id={id} aria-describedby={describedBy} invalid={invalid} />
        )}
      </LnField>,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("aria-describedby=");
  });
});

// ---------------------------------------------------------------------------
// OpField
// ---------------------------------------------------------------------------

describe("OpField — aria linkage", () => {
  it("passes a non-empty id to the render-prop", () => {
    let capturedId = "";
    renderToStaticMarkup(
      <OpField label="Matrícula">
        {({ id }) => {
          capturedId = id;
          return <input id={id} />;
        }}
      </OpField>,
    );
    expect(capturedId).toBeTruthy();
  });

  it("renders the label's htmlFor matching the control id", () => {
    const html = renderToStaticMarkup(
      <OpField label="Fecha del incidente">
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
        )}
      </OpField>,
    );
    const labelMatch = html.match(/for="([^"]+)"/);
    const inputMatch = html.match(/id="([^"]+)"/);
    expect(labelMatch).not.toBeNull();
    expect(inputMatch).not.toBeNull();
    expect(labelMatch![1]).toBe(inputMatch![1]);
  });

  it("sets aria-invalid on the control when error is present", () => {
    const html = renderToStaticMarkup(
      <OpField label="Matrícula" error="Formato incorrecto">
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
        )}
      </OpField>,
    );
    expect(html).toContain('aria-invalid="true"');
  });

  it("does NOT set aria-invalid when no error", () => {
    const html = renderToStaticMarkup(
      <OpField label="Matrícula">
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
        )}
      </OpField>,
    );
    expect(html).not.toContain("aria-invalid");
  });

  it("sets aria-describedby pointing at the rendered error element", () => {
    let capturedDescribedBy: string | undefined;
    const html = renderToStaticMarkup(
      <OpField label="Matrícula" error="Formato incorrecto">
        {({ id, describedBy, invalid }) => {
          capturedDescribedBy = describedBy;
          return (
            <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
          );
        }}
      </OpField>,
    );
    expect(capturedDescribedBy).toBeTruthy();
    expect(html).toContain(`id="${capturedDescribedBy}"`);
    expect(html).toContain(`aria-describedby="${capturedDescribedBy}"`);
    expect(html).toContain("Formato incorrecto");
  });

  it("does NOT emit aria-describedby when no error and no hint", () => {
    const html = renderToStaticMarkup(
      <OpField label="Matrícula">
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
        )}
      </OpField>,
    );
    expect(html).not.toContain("aria-describedby");
  });

  it("sets aria-describedby pointing at the hint element when hint present and no error", () => {
    let capturedDescribedBy: string | undefined;
    const html = renderToStaticMarkup(
      <OpField label="Token" hint="Formato DIM-XXXX-XXXX">
        {({ id, describedBy, invalid }) => {
          capturedDescribedBy = describedBy;
          return (
            <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
          );
        }}
      </OpField>,
    );
    expect(capturedDescribedBy).toBeTruthy();
    expect(html).toContain(`id="${capturedDescribedBy}"`);
    expect(html).toContain("Formato DIM-XXXX-XXXX");
  });

  it("renders the required asterisk when required=true", () => {
    const html = renderToStaticMarkup(
      <OpField label="Severidad" required>
        {({ id }) => <input id={id} />}
      </OpField>,
    );
    expect(html).toContain("*");
  });

  it("does NOT render the required asterisk when required is not set", () => {
    const html = renderToStaticMarkup(
      <OpField label="Contexto">{({ id }) => <input id={id} />}</OpField>,
    );
    // The danger-colored asterisk span should not appear
    expect(html).not.toContain("text-ln-op-danger");
  });

  it("error element carries role=alert", () => {
    const html = renderToStaticMarkup(
      <OpField label="Matrícula" error="Requerido">
        {({ id }) => <input id={id} />}
      </OpField>,
    );
    expect(html).toContain('role="alert"');
  });
});
