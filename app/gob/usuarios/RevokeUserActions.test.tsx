// @vitest-environment jsdom
//
// RevokeUserActions — post-revoke reload fix (audit-3-feedback §C2
// asymmetry #4, 2026-07-21): this file's own comment claimed to mirror
// RevokeOrgActions.tsx's ADR-3 structure, but only RevokeOrgActions called
// navigateAfterActionSuccess after a successful revoke — this file left the
// page stale (the vet's role badge kept showing "Vet" after an equally
// irreversible action). Fixed to reload like its sibling; this test pins
// that the reload now fires on success and NOT on a failed submit.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revokeVetRoleAction = vi.fn();
vi.mock("@/app/actions/admin-revocations", () => ({
  revokeVetRoleAction: (...args: unknown[]) => revokeVetRoleAction(...args),
}));

const uploadRevocationEvidence = vi.fn();
vi.mock("@/app/actions/revocation-evidence", () => ({
  uploadRevocationEvidence: (...args: unknown[]) => uploadRevocationEvidence(...args),
}));

const storageUpload = vi.fn();
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    storage: {
      from: () => ({ upload: (...args: unknown[]) => storageUpload(...args) }),
    },
  }),
}));

const navigateAfterActionSuccess = vi.fn();
vi.mock("@/lib/ui/full-page-action-nav", () => ({
  navigateAfterActionSuccess: (...args: unknown[]) => navigateAfterActionSuccess(...args),
}));

import { RevokeUserActions } from "./RevokeUserActions";

const target = {
  id: "user-1",
  displayName: "Dra. Pérez",
  matriculaJurisdiccion: "AR-B",
  role: "vet" as const,
};

function renderRevoke() {
  return render(
    <RevokeUserActions
      target={target}
      actorUserId="admin-1"
      actorRole="admin"
      jurisdictions={[]}
    />,
  );
}

// Drives the form up to a submittable state: motivo >= 30 chars, one
// uploaded evidence file, and the acknowledgment checkbox checked.
async function fillSubmittableForm() {
  fireEvent.click(screen.getByRole("button", { name: "Revocar rol vet" }));

  fireEvent.change(screen.getByLabelText(/Motivo \(mínimo 30 caracteres\)/), {
    target: { value: "Denuncias reiteradas verificadas por la autoridad sanitaria." },
  });

  const file = new File(["x"], "evidencia.pdf", { type: "application/pdf" });
  const fileInput = screen.getByLabelText("Evidencia (al menos 1 archivo)");
  fireEvent.change(fileInput, { target: { files: [file] } });

  await waitFor(() => {
    expect(screen.getByText("evidencia.pdf")).toBeInTheDocument();
  });

  fireEvent.click(
    screen
      .getByText(/Confirmo que quiero revocar el rol veterinario/)
      .closest("label")!
      .querySelector("input")!,
  );
}

beforeEach(() => {
  revokeVetRoleAction.mockReset();
  uploadRevocationEvidence.mockReset();
  storageUpload.mockReset();
  navigateAfterActionSuccess.mockReset();
  storageUpload.mockResolvedValue({ error: null });
  uploadRevocationEvidence.mockResolvedValue({ attachmentId: "att-1" });
});

afterEach(() => {
  cleanup();
});

describe("RevokeUserActions — reload parity with RevokeOrgActions", () => {
  it("reloads the page after a successful revoke", async () => {
    revokeVetRoleAction.mockResolvedValue({ ok: true });
    renderRevoke();

    await fillSubmittableForm();
    fireEvent.click(screen.getByRole("button", { name: "Revocar" }));

    await waitFor(() => {
      expect(screen.getByText(/Rol vet revocado/)).toBeInTheDocument();
    });
    expect(navigateAfterActionSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the revoke fails", async () => {
    revokeVetRoleAction.mockResolvedValue({ error: "Fuera de tu jurisdicción." });
    renderRevoke();

    await fillSubmittableForm();
    fireEvent.click(screen.getByRole("button", { name: "Revocar" }));

    await waitFor(() => {
      expect(screen.getByText("Fuera de tu jurisdicción.")).toBeInTheDocument();
    });
    expect(navigateAfterActionSuccess).not.toHaveBeenCalled();
  });
});
