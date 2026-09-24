// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { OpBulkBar } from "./OpBulkBar";

// jsdom doesn't implement native <dialog>.showModal/close (ConfirmDialog calls
// them). Stub them so the confirm path renders without throwing.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});

// Guards the requireConfirm branch added for the /org bulk-"Aprobar" fix: a
// consequential-but-not-destructive bulk action (e.g. an approval that notifies
// applicants) must NOT fire on a single click — it gates behind a confirm — while
// a plain action still fires immediately.
describe("OpBulkBar — action gating", () => {
  it("a plain action runs immediately on click (no confirm)", () => {
    const onRun = vi.fn();
    render(
      <OpBulkBar
        count={2}
        onClear={() => {}}
        actions={[{ key: "plain", label: "Hacer algo", onRun }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hacer algo" }));
    expect(onRun).toHaveBeenCalledWith("");
  });

  it("a requireConfirm action does NOT run on the first click — it opens a confirm", () => {
    const onRun = vi.fn();
    render(
      <OpBulkBar
        count={2}
        onClear={() => {}}
        actions={[
          {
            key: "approve",
            label: "Aprobar seleccionadas",
            requireConfirm: true,
            confirmLabel: "Aprobar postulaciones",
            confirmTitle: "Aprobar postulaciones",
            onRun,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Aprobar seleccionadas" }));
    // The action is gated: onRun is not called yet, and no reason textarea is
    // shown (confirm-only, not requireReason).
    expect(onRun).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/Motivo/i)).toBeNull();
  });
});
