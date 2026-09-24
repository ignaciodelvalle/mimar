// @vitest-environment jsdom
//
// ConfirmDialog — regression coverage for the focus-restore effect (QA
// 2026-07-21, /gob/decomisos landing scrolled to the BOTTOM of the page on
// every load and after every filter change). Root cause: the "return focus
// to the trigger when the dialog closes" effect fired on every instance's
// initial mount too (open starts `false`), not just on a real open→close
// transition. A page rendering MANY ConfirmDialog instances at once (one per
// list row — Reasignar/Devolver al dueño per decomiso) meant every closed
// instance called `.focus()` on mount; the LAST one in DOM order always won
// the race, and the browser auto-scrolled that now-focused trigger into
// view. These tests pin: mounting several closed instances steals focus from
// NONE of them, while a genuine open → close cycle still restores focus to
// its own trigger (the a11y behavior the effect exists for).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

// jsdom doesn't implement native <dialog>.showModal/close (ConfirmDialog calls
// them) — stub so the confirm path renders without throwing, toggling the
// `open` attribute too (RTL/jsdom treats a dialog without it as hidden and
// excludes its content from role queries).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

afterEach(() => {
  cleanup();
});

function RowWithConfirm({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => setOpen(false)}
        title={`Eliminar — ${label}`}
        confirmLabel="Eliminar"
        triggerRef={triggerRef}
      />
    </>
  );
}

describe("<ConfirmDialog> — focus-restore effect", () => {
  it("does NOT steal focus from any trigger when several closed instances mount at once", () => {
    render(
      <>
        <RowWithConfirm label="Fila 1" />
        <RowWithConfirm label="Fila 2" />
        <RowWithConfirm label="Fila 3 (última)" />
      </>,
    );
    // No trigger should be the active element — mounting closed dialogs must
    // never move focus (that's what previously scrolled the page to whichever
    // row rendered last).
    for (const label of ["Fila 1", "Fila 2", "Fila 3 (última)"]) {
      expect(screen.getByRole("button", { name: label })).not.toHaveFocus();
    }
    expect(document.activeElement).toBe(document.body);
  });

  it("restores focus to its trigger after a genuine open → close cycle", () => {
    render(<RowWithConfirm label="Fila 2" />);
    const trigger = screen.getByRole("button", { name: "Fila 2" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(trigger).toHaveFocus();
  });
});
