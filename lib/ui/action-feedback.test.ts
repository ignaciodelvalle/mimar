// Tests for lib/ui/action-feedback.ts — the mutation-feedback convention
// helper (audit-3-feedback §C1, 2026-07-21). Thin wrappers around sonner;
// the test just pins that notifySaved/notifyActionError call the right
// sonner method with the right tone, since that contract is the whole
// point of having a single shared helper instead of ad hoc `toast.*` calls.

import { describe, expect, it, vi } from "vitest";

const success = vi.fn();
const error = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => success(...args),
    error: (...args: unknown[]) => error(...args),
  },
}));

import {
  UNDOABLE_TOAST_DURATION_MS,
  notifyActionError,
  notifySaved,
  notifyUndoable,
} from "./action-feedback";

describe("notifySaved", () => {
  it("fires toast.success with the given message", () => {
    notifySaved("Transferencia aceptada");
    expect(success).toHaveBeenCalledWith("Transferencia aceptada");
  });

  it("defaults to 'Listo' when no message is passed", () => {
    notifySaved();
    expect(success).toHaveBeenCalledWith("Listo");
  });
});

describe("notifyActionError", () => {
  it("fires toast.error with the given message", () => {
    notifyActionError("No se pudo guardar.");
    expect(error).toHaveBeenCalledWith("No se pudo guardar.");
  });
});

describe("notifyUndoable (Q5 — first undo pattern)", () => {
  it("fires toast.success with a Deshacer action and the extended duration", () => {
    notifyUndoable("Te asignaste la denuncia", { onUndo: () => {} });
    const [message, options] = success.mock.calls.at(-1) as [
      string,
      { duration: number; action: { label: string; onClick: () => void } },
    ];
    expect(message).toBe("Te asignaste la denuncia");
    expect(options.duration).toBe(UNDOABLE_TOAST_DURATION_MS);
    expect(options.action.label).toBe("Deshacer");
  });

  it("invokes the caller's inverse action when the toast action is clicked", () => {
    const onUndo = vi.fn();
    notifyUndoable("Listo", { onUndo });
    const [, options] = success.mock.calls.at(-1) as [string, { action: { onClick: () => void } }];
    options.action.onClick();
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it("honors a custom action label", () => {
    notifyUndoable("Denuncia liberada", { label: "Volver a tomar", onUndo: () => {} });
    const [, options] = success.mock.calls.at(-1) as [string, { action: { label: string } }];
    expect(options.action.label).toBe("Volver a tomar");
  });
});
