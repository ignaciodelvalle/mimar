// Structural / a11y tests for <OpButton> (design-system F3).
//
// Render via react-dom/server → HTML string (repo pattern, no jsdom).
// Covers: all 4 variants, 3 sizes, block modifier, loading state (disabled +
// aria-busy + spinner), type forwarding, onClick forwarding, disabled prop.

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OpButton } from "@/components/ui/dashboard/OpButton";

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

describe("<OpButton> — variants", () => {
  it("primary (default) renders azul background", () => {
    const html = render(<OpButton>Guardar</OpButton>);
    expect(html).toContain("ln-op-azul");
    expect(html).toContain(">Guardar<");
  });

  it("ghost renders op card/ink classes", () => {
    const html = render(<OpButton variant="ghost">Cancelar</OpButton>);
    expect(html).toContain("ln-op-card");
    expect(html).toContain("ln-op-ink");
    expect(html).not.toContain("ln-op-azul");
  });

  it("danger renders op danger background", () => {
    const html = render(<OpButton variant="danger">Eliminar</OpButton>);
    expect(html).toContain("ln-op-danger");
    expect(html).not.toContain("ln-op-azul");
  });

  it("ok renders op ok (green) background", () => {
    const html = render(<OpButton variant="ok">Confirmar alta</OpButton>);
    expect(html).toContain("ln-op-ok");
    expect(html).not.toContain("ln-op-azul");
  });
});

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

describe("<OpButton> — sizes", () => {
  it("sm renders small padding", () => {
    const html = render(<OpButton size="sm">Acción</OpButton>);
    expect(html).toContain("px-[11px]");
  });

  it("md is the default and renders medium padding", () => {
    const html = render(<OpButton>Acción</OpButton>);
    // px-3.5 === 14px (Tailwind step); the st-token migration replaced the
    // value-equal arbitrary px-[14px] with the token step.
    expect(html).toContain("px-3.5");
  });

  it("lg renders large padding", () => {
    const html = render(<OpButton size="lg">Acción</OpButton>);
    expect(html).toContain("px-[18px]");
  });
});

// ---------------------------------------------------------------------------
// block modifier
// ---------------------------------------------------------------------------

describe("<OpButton> — block modifier", () => {
  it("block=true adds w-full", () => {
    const html = render(<OpButton block>Guardar</OpButton>);
    expect(html).toContain("w-full");
  });

  it("block=false (default) does not add w-full to class list", () => {
    const html = render(<OpButton>Guardar</OpButton>);
    // w-full should NOT appear when block is false (spinner uses h-4 w-4, not w-full)
    expect(html).not.toContain("w-full");
  });
});

// ---------------------------------------------------------------------------
// loading state
// ---------------------------------------------------------------------------

describe("<OpButton> — loading state", () => {
  it("loading=true disables the button", () => {
    const html = render(<OpButton loading>Guardando…</OpButton>);
    expect(html).toContain("disabled");
  });

  it("loading=true sets aria-busy", () => {
    const html = render(<OpButton loading>Guardando…</OpButton>);
    expect(html).toContain('aria-busy="true"');
  });

  it("loading=true renders a spinner (animate-spin)", () => {
    const html = render(<OpButton loading>Guardando…</OpButton>);
    expect(html).toContain("animate-spin");
  });

  it("loading=false does not render spinner", () => {
    const html = render(<OpButton loading={false}>Guardar</OpButton>);
    expect(html).not.toContain("animate-spin");
  });
});

// ---------------------------------------------------------------------------
// disabled prop
// ---------------------------------------------------------------------------

describe("<OpButton> — disabled", () => {
  it("disabled=true marks the button disabled", () => {
    const html = render(<OpButton disabled>Guardar</OpButton>);
    expect(html).toContain("disabled");
  });

  it("disabled does not set aria-busy", () => {
    const html = render(<OpButton disabled>Guardar</OpButton>);
    expect(html).not.toContain("aria-busy");
  });
});

// ---------------------------------------------------------------------------
// type forwarding
// ---------------------------------------------------------------------------

describe("<OpButton> — type forwarding", () => {
  it('defaults to type="button"', () => {
    const html = render(<OpButton>Acción</OpButton>);
    expect(html).toContain('type="button"');
  });

  it('accepts type="submit"', () => {
    const html = render(<OpButton type="submit">Enviar</OpButton>);
    expect(html).toContain('type="submit"');
  });
});

// ---------------------------------------------------------------------------
// onClick forwarding (static render — verifies the attribute is not lost)
// ---------------------------------------------------------------------------

describe("<OpButton> — onClick forwarding", () => {
  it("onClick does not throw during static render (forwarded via spread)", () => {
    const handler = vi.fn();
    // renderToStaticMarkup doesn't attach event handlers, but it should not throw
    expect(() => render(<OpButton onClick={handler}>Acción</OpButton>)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Operator button radius token
// ---------------------------------------------------------------------------

describe("<OpButton> — radius", () => {
  it("uses the --radius-op-btn CSS variable", () => {
    const html = render(<OpButton>Acción</OpButton>);
    expect(html).toContain("--radius-op-btn");
  });
});
