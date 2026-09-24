// Structural / a11y tests for <OpBulkBar> (Wave 2 Item 10.2).
//
// Render via react-dom/server → HTML string (repo pattern, no jsdom). useState
// and useRef are stubbed so we can drive the rendered state deterministically.
//
// The selection state machine + reason gate are unit-tested in
// bulk-select.test.ts; here we assert the rendered a11y contract:
//   - hidden when count === 0
//   - role="region" aria-label="Acciones en lote"
//   - count announced via aria-live="polite"
//   - one button per action + a "Limpiar" clear button

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUseState = vi.fn((initialValue: unknown) => [initialValue, vi.fn()]);
const mockUseRef = vi.fn(() => ({ current: null }));

vi.mock("react", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof React;
  return {
    ...actual,
    useState: (initialValue: unknown) => mockUseState(initialValue),
    useRef: () => mockUseRef(),
  };
});

import { OpBulkBar } from "@/components/ui/dashboard/OpBulkBar";

const ACTIONS = [
  { key: "revoke", label: "Revocar seleccionados", tone: "danger" as const, onRun: vi.fn() },
];

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

beforeEach(() => {
  // Default: no active confirm dialog (activeAction=null), no reason, not pending.
  mockUseState.mockImplementation((initialValue: unknown) => [initialValue, vi.fn()]);
  mockUseRef.mockImplementation(() => ({ current: null }));
});

describe("<OpBulkBar> — visibility", () => {
  it("renders nothing when count is 0", () => {
    const html = render(<OpBulkBar count={0} actions={ACTIONS} onClear={vi.fn()} />);
    expect(html).toBe("");
  });

  it("renders the bar when count ≥ 1", () => {
    const html = render(<OpBulkBar count={2} actions={ACTIONS} onClear={vi.fn()} />);
    expect(html).not.toBe("");
  });
});

describe("<OpBulkBar> — a11y contract", () => {
  it('uses role="region" with aria-label="Acciones en lote"', () => {
    const html = render(<OpBulkBar count={1} actions={ACTIONS} onClear={vi.fn()} />);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Acciones en lote"');
  });

  it('announces the count via aria-live="polite"', () => {
    const html = render(<OpBulkBar count={3} actions={ACTIONS} onClear={vi.fn()} />);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("3 seleccionados");
  });

  it("uses the singular form for exactly one selection", () => {
    const html = render(<OpBulkBar count={1} actions={ACTIONS} onClear={vi.fn()} />);
    expect(html).toContain("1 seleccionado");
    expect(html).not.toContain("1 seleccionados");
  });
});

describe("<OpBulkBar> — actions", () => {
  it("renders a button per action plus a clear button", () => {
    const html = render(<OpBulkBar count={1} actions={ACTIONS} onClear={vi.fn()} />);
    expect(html).toContain("Revocar seleccionados");
    expect(html).toContain("Limpiar");
  });

  it("renders multiple actions", () => {
    const actions = [ACTIONS[0], { key: "export", label: "Exportar", onRun: vi.fn() }];
    const html = render(<OpBulkBar count={1} actions={actions} onClear={vi.fn()} />);
    expect(html).toContain("Revocar seleccionados");
    expect(html).toContain("Exportar");
  });
});
