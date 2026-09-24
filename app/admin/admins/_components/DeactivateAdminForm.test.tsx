// @vitest-environment jsdom
//
// DeactivateAdminForm — a successful deactivation must not re-render the
// stale confirming/pending tree before the full-page reload takes over.
//
// Fresh review, 2026-09-24 (Q1): the submit success path used to call
// navigateAfterActionSuccess(window.location.href) — a full
// window.location.assign(), which discards this whole React tree — and THEN
// call onDone(), which set the parent's mode to "done" and re-rendered it.
// That re-render is real work the browser has to paint a beat before the
// document actually unloads: a stray render of a stale tree, visible as a
// flash right before the reload replaces it. The fix drops the onDone() call
// on the (only) success path, which always navigates. This test proves it by
// asserting the "done" text never appears after a successful submit, while
// the navigation call itself still fires.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/admin-institutional", () => ({
  deactivateAdminAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: vi.fn(),
}));

vi.mock("@/lib/ui/use-evidence-upload", () => ({
  useEvidenceUpload: () => ({
    selectedFiles: [{ key: "f1", file: new File(["x"], "evidencia.pdf") }],
    uploading: false,
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    reset: vi.fn(),
    uploadAll: vi.fn(async () => ({ attachmentIds: ["att-1"] })),
  }),
}));

import { deactivateAdminAction } from "@/app/actions/admin-institutional";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

import { DeactivateAdminActions } from "./DeactivateAdminForm";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ACTOR = {
  id: "admin-1",
  role: "admin" as const,
  accountType: "institutional" as const,
  deactivatedAt: null,
};

const TARGET = { id: "admin-2", displayName: "Ana Admin" };

async function submitDeactivation() {
  render(<DeactivateAdminActions target={TARGET} actor={ACTOR} activeAdminCount={2} />);

  fireEvent.click(screen.getByRole("button", { name: /desactivar admin/i }));

  fireEvent.change(screen.getByLabelText(/motivo/i), {
    target: { value: "Cuenta comprometida — se detectaron accesos no autorizados." },
  });
  fireEvent.click(screen.getByRole("checkbox"));

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^desactivar$/i }));
  });
}

describe("DeactivateAdminForm — success path does not re-render a stale tree", () => {
  it("calls the server action and navigates on success", async () => {
    await submitDeactivation();
    await waitFor(() => expect(deactivateAdminAction).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigateAfterActionSuccess).toHaveBeenCalledWith(window.location.href),
    );
  });

  it("never renders the done state after a successful submit (onDone not called)", async () => {
    await submitDeactivation();
    await waitFor(() => expect(navigateAfterActionSuccess).toHaveBeenCalled());
    // If onDone() still ran, the parent's mode flips to "done" and this text
    // appears — the exact stray render the fix removes.
    expect(screen.queryByText(/admin desactivado/i)).not.toBeInTheDocument();
    // The confirming form (with the button just clicked) is still the tree
    // on screen — nothing unmounted it, because nothing re-rendered the parent.
    expect(screen.getByRole("button", { name: /^desactivar$/i })).toBeInTheDocument();
  });
});
