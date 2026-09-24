// @vitest-environment jsdom
//
// AuditActionFilter — the Acción control for /admin/auditoria
// (F-migration 2026-07-21). Default (no `action` param) is genuinely "todas
// las acciones" — no blank-option trap here (unlike AlertEstadoFilter /
// CasoEstadoFilter). These tests pin the TWO render shapes:
//   1. single/absent action → a plain <select> that commits `action` via
//      serverNavCommit, dropping `resetParamsOnChange` (the keyset cursor).
//   2. a multi-action KPI drill (e.g. "Decisiones 7d") → a read-only locked
//      chip, matching the pre-migration <form>'s hidden-input behavior — no
//      select is rendered, so it cannot be changed from this control.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockAssign = vi.fn();
const originalLocation = window.location;

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { AuditActionFilter } from "./AuditActionFilter";

const ACTION_OPTIONS = [
  { value: "request_approved", label: "Solicitud aprobada" },
  { value: "request_rejected", label: "Solicitud rechazada" },
  { value: "pii_queried", label: "Búsqueda de datos personales" },
];

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
  const current = new URL(url, "http://localhost");
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, ...current, assign: mockAssign },
  });
}

afterEach(() => {
  cleanup();
  mockAssign.mockClear();
});

describe("<AuditActionFilter> — single-select shape", () => {
  it('renders "Todas las acciones" plus the given options', () => {
    setUrl("/admin/auditoria");
    render(
      <AuditActionFilter
        actionOptions={ACTION_OPTIONS}
        selectedValue=""
        multiActionLabels={null}
      />,
    );
    const select = screen.getByLabelText("Acción") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => ({ value: o.value, label: o.text }));
    expect(options).toEqual([{ value: "", label: "Todas las acciones" }, ...ACTION_OPTIONS]);
  });

  it("commits the selected action and drops the cursor", () => {
    setUrl("/admin/auditoria?cursor=abc123");
    render(
      <AuditActionFilter
        actionOptions={ACTION_OPTIONS}
        selectedValue=""
        multiActionLabels={null}
        resetParamsOnChange={["cursor"]}
      />,
    );
    fireEvent.change(screen.getByLabelText("Acción"), { target: { value: "pii_queried" } });
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/admin/auditoria");
    expect(url.searchParams.get("action")).toBe("pii_queried");
    expect(url.searchParams.get("cursor")).toBeNull();
  });

  it('clearing back to "Todas las acciones" removes the action param', () => {
    setUrl("/admin/auditoria?action=pii_queried");
    render(
      <AuditActionFilter
        actionOptions={ACTION_OPTIONS}
        selectedValue="pii_queried"
        multiActionLabels={null}
      />,
    );
    fireEvent.change(screen.getByLabelText("Acción"), { target: { value: "" } });
    const url = new URL(mockAssign.mock.calls[0][0] as string, "http://localhost/admin/auditoria");
    expect(url.searchParams.get("action")).toBeNull();
  });
});

describe("<AuditActionFilter> — multi-action KPI-drill locked chip", () => {
  it("renders a read-only chip instead of a select when multiActionLabels is set", () => {
    setUrl("/admin/auditoria?action=request_approved,request_rejected");
    render(
      <AuditActionFilter
        actionOptions={ACTION_OPTIONS}
        selectedValue=""
        multiActionLabels={["Solicitud aprobada", "Solicitud rechazada"]}
      />,
    );
    expect(screen.queryByLabelText("Acción")).toBeNull();
    expect(screen.getByText("Solicitud aprobada + Solicitud rechazada")).toBeInTheDocument();
  });
});
