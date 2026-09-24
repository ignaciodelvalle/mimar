// @vitest-environment jsdom
// The DOM predicate behind the D.12 noisy failure. It is the only thing that
// stops the notice from firing on a healthy-but-slow submit, so its false
// positives and false negatives are both user-visible: a false positive tells a
// vet whose signature is landing fine that we could not confirm it; a false
// negative leaves the eternal "Registrando…" in place.

import { describe, expect, it } from "vitest";

import { ACTION_STALL_COPY, ACTION_STALL_MS, hasPendingSubmit } from "./action-stall";

function dom(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("hasPendingSubmit", () => {
  it("is false for a null root", () => {
    expect(hasPendingSubmit(null)).toBe(false);
    expect(hasPendingSubmit(undefined)).toBe(false);
  });

  it("is false for an idle form", () => {
    expect(hasPendingSubmit(dom('<form><button type="submit">Registrar</button></form>'))).toBe(
      false,
    );
  });

  it("sees LnSheetFooter's pending control (aria-busy)", () => {
    expect(
      hasPendingSubmit(dom('<button type="submit" aria-busy="true">Registrando…</button>')),
    ).toBe(true);
  });

  it("sees a disabled submit button even without aria-busy", () => {
    expect(hasPendingSubmit(dom('<button type="submit" disabled>Registrando…</button>'))).toBe(
      true,
    );
  });

  it("sees the footer's out-of-form control wired by form=", () => {
    expect(hasPendingSubmit(dom('<button form="nota-form" disabled>Registrando…</button>'))).toBe(
      true,
    );
  });

  it("does NOT fire on an unrelated disabled control", () => {
    // A disabled text input or a disabled non-submit button is ordinary form
    // state, not a submit in flight.
    expect(hasPendingSubmit(dom('<input type="text" disabled />'))).toBe(false);
    expect(hasPendingSubmit(dom('<button type="button" disabled>Cancelar</button>'))).toBe(false);
  });

  it('does NOT fire on aria-busy="false"', () => {
    expect(
      hasPendingSubmit(dom('<button type="submit" aria-busy="false">Registrar</button>')),
    ).toBe(false);
  });
});

describe("ACTION_STALL contract", () => {
  it("waits well past a legitimate slow action before accusing the surface", () => {
    expect(ACTION_STALL_MS).toBeGreaterThanOrEqual(5000);
  });

  it("never claims the action failed or succeeded, on either surface", () => {
    for (const copy of Object.values(ACTION_STALL_COPY)) {
      const text = `${copy.title} ${copy.body}`;
      expect(text).toMatch(/No pudimos confirmar/);
      expect(text).not.toMatch(/falló|no se pudo (registrar|guardar)|error/i);
      expect(text).not.toMatch(/con éxito|guardado correctamente/i);
      // Point them at the record before they act again — the whole reason the
      // notice exists (PO D.12).
      expect(text).toMatch(/antes de volver a/i);
      expect(text).toMatch(/duplica/i);
    }
  });
});
