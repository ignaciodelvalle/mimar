// @vitest-environment jsdom
//
// DeactivateGovtForm — same fix and same proof as
// app/admin/admins/_components/DeactivateAdminForm.test.tsx (Q1, fresh review
// 2026-09-24): a successful deactivation always navigates via
// navigateAfterActionSuccess (a full window.location.assign()), so calling
// onDone() afterward only re-rendered a tree the browser was about to
// discard — a stray render of a stale tree, visible as a flash right before
// the reload replaces it.

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/admin-institutional", () => ({
  deactivateGovtAction: vi.fn(async () => ({ ok: true })),
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

import { deactivateGovtAction } from "@/app/actions/admin-institutional";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";

import { DeactivateGovtActions } from "./DeactivateGovtForm";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TARGET = { id: "govt-1", displayName: "Municipio de Prueba", activeLocalityCount: 2 };

async function submitDeactivation() {
  render(<DeactivateGovtActions target={TARGET} />);

  fireEvent.click(screen.getByRole("button", { name: /desactivar gobierno/i }));

  fireEvent.change(screen.getByLabelText(/motivo/i), {
    target: { value: "Cuenta comprometida — se detectaron accesos no autorizados." },
  });
  fireEvent.click(screen.getByRole("checkbox"));

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^desactivar$/i }));
  });
}

describe("DeactivateGovtForm — success path does not re-render a stale tree", () => {
  it("calls the server action and navigates on success", async () => {
    await submitDeactivation();
    await waitFor(() => expect(deactivateGovtAction).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigateAfterActionSuccess).toHaveBeenCalledWith(window.location.href),
    );
  });

  it("never renders the done state after a successful submit (onDone not called)", async () => {
    await submitDeactivation();
    await waitFor(() => expect(navigateAfterActionSuccess).toHaveBeenCalled());
    expect(screen.queryByText(/gobierno desactivado/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^desactivar$/i })).toBeInTheDocument();
  });
});
