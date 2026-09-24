// @vitest-environment jsdom
//
// RevokeTagDialog — the "Motivo" select must be labelled PER ROW.
//
// TagList renders one RevokeTagDialog per ACTIVE chapa (TagList.tsx), and this
// dialog used to hardcode `htmlFor="revoke-tag-reason"` / `id="revoke-tag-reason"`.
// With N active chapas the document carried N labels and N selects sharing ONE
// id, so `label.control` — and therefore `select.labels` — resolved to the FIRST
// select in the document for every row.
//
// User-visible harm: an owner with two or more active chapas opens "Dar de baja"
// on any row but the first. The dialog paints correctly, but the visible label
// belongs to a different row's control: a screen reader announces the select with
// NO accessible name, and clicking the label focuses a control inside a CLOSED
// <dialog>. It also broke e2e/chapas.spec.ts deterministically on any database
// with more than one active tag (`dialog.getByLabel(/motivo/i)` reads
// `element.labels`); CI passed only because a fresh DB has exactly one tag, which
// is always the first row.
//
// Same class the repo already fixed once — see components/MotivoField.tsx:
// "Three of those hardcoded the textarea id (duplicate-id smell when more than
// one row renders); this shared version derives it from useId()."

import "@testing-library/jest-dom/vitest";

import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/tags", () => ({
  revokeTagAction: vi.fn(),
}));

import { RevokeTagDialog } from "./RevokeTagDialog";

// jsdom doesn't implement native <dialog>.showModal/close (ConfirmDialog calls
// them) — stub so the open path renders without throwing, toggling the `open`
// attribute too (RTL/jsdom treats a dialog without it as hidden).
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

/** Two active chapas — the exact shape TagList produces for a two-tag owner. */
function renderTwoRows() {
  return render(
    <>
      <RevokeTagDialog serial="DIM-AAAA-1111" open onOpenChange={() => {}} />
      <RevokeTagDialog serial="DIM-BBBB-2222" open onOpenChange={() => {}} />
    </>,
  );
}

describe("RevokeTagDialog — per-row label association", () => {
  it("gives every row's Motivo select its OWN label", () => {
    const { container } = renderTwoRows();

    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects).toHaveLength(2);

    for (const select of selects) {
      // Exactly one label, and it is THIS select's label — not row 1's.
      expect(Array.from(select.labels ?? [])).toHaveLength(1);
      expect(select.labels?.[0]?.control).toBe(select);
      expect(select.labels?.[0]).toHaveTextContent(/motivo/i);
    }
  });

  it("does not reuse one DOM id across rows", () => {
    const { container } = renderTwoRows();

    const ids = Array.from(container.querySelectorAll("select")).map((s) => s.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves getByLabelText inside EACH dialog (what the e2e getByLabel does)", () => {
    const { container } = renderTwoRows();

    const dialogs = Array.from(container.querySelectorAll("dialog"));
    expect(dialogs).toHaveLength(2);

    for (const dialog of dialogs) {
      const labelled = within(dialog as HTMLElement).getByLabelText(/motivo/i);
      expect(labelled).toBe(dialog.querySelector("select"));
    }
  });
});
