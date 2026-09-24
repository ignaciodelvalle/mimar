// @vitest-environment jsdom
//
// Interaction test for the RUPGA revoke console (bug fix: the fully-built and
// tested revokeServiceDogCredentialAction backend had no UI caller anywhere
// in app/gob or app/admin). Exercises the real confirm → motivo → checkbox →
// submit flow via RTL + jsdom, mirroring the pattern used by
// NumericWindowRuleForm.interaction.test.tsx — mock the server action module,
// drive the DOM, assert the mock is called with the exact expected input.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revokeActionMock = vi.fn();
vi.mock("@/app/actions/service-dog", () => ({
  revokeServiceDogCredentialAction: (...args: unknown[]) => revokeActionMock(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({}),
}));

import type { ServiceDogCredentialSearchResult } from "@/lib/infra/admin-search";

import { RevokeServiceDogActions } from "./RevokeServiceDogActions";

const CREDENTIAL: ServiceDogCredentialSearchResult = {
  petId: "pet-1",
  petPublicToken: "DIM-TEST-0001",
  petName: "Firulais",
  serviceType: "guia",
  credentialStatus: "vigente",
  rupgaCredential: "RUPGA-0001",
  jurisdictionProvince: "Córdoba",
  jurisdictionLocality: "Villa María",
};

const VALID_MOTIVO = "El titular no cumplió con la renovación anual de la certificación RUPGA.";

beforeEach(() => {
  revokeActionMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("<RevokeServiceDogActions> — RUPGA credential revocation console", () => {
  it("admin sees the trigger button and opens the confirm form", () => {
    render(
      <RevokeServiceDogActions credential={CREDENTIAL} actorRole="admin" jurisdictions={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revocar credencial" }));
    expect(screen.getByText(/Revocar credencial RUPGA — Firulais/)).toBeInTheDocument();
  });

  it("submits with the pet token + trimmed motivo once the reason clears 30 chars and confirm is checked", async () => {
    revokeActionMock.mockResolvedValue({ ok: true });

    render(
      <RevokeServiceDogActions credential={CREDENTIAL} actorRole="admin" jurisdictions={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revocar credencial" }));

    fireEvent.change(screen.getByLabelText(/Motivo/i), { target: { value: VALID_MOTIVO } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Revocar" }));

    await waitFor(() => {
      expect(revokeActionMock).toHaveBeenCalledWith({
        petPublicToken: "DIM-TEST-0001",
        motivo: VALID_MOTIVO,
      });
    });
    // Success settles the UI to the "done" state; the list drops the credential
    // via the action's server-side revalidatePath("/gob/rupga"), not a client
    // router.refresh().
    await waitFor(() => {
      expect(screen.getByText(/Credencial revocada/)).toBeInTheDocument();
    });
  });

  it("the submit button stays disabled until the reason is >=30 chars AND confirm is checked", () => {
    render(
      <RevokeServiceDogActions credential={CREDENTIAL} actorRole="admin" jurisdictions={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revocar credencial" }));

    const submitButton = screen.getByRole("button", { name: "Revocar" });
    expect(submitButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Motivo/i), { target: { value: "muy corto" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submitButton).toBeDisabled();

    expect(revokeActionMock).not.toHaveBeenCalled();
  });

  it("a govt actor outside the credential's jurisdiction never sees the trigger", () => {
    render(
      <RevokeServiceDogActions
        credential={CREDENTIAL}
        actorRole="govt"
        jurisdictions={[{ province: "Buenos Aires", locality: "La Plata" }]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Revocar credencial" })).toBeNull();
  });

  it("a govt actor scoped to the credential's jurisdiction sees the trigger", () => {
    render(
      <RevokeServiceDogActions
        credential={CREDENTIAL}
        actorRole="govt"
        jurisdictions={[{ province: "Córdoba", locality: "Villa María" }]}
      />,
    );
    expect(screen.getByRole("button", { name: "Revocar credencial" })).toBeInTheDocument();
  });

  it("surfaces the action's error message and does not flip to the done state", async () => {
    revokeActionMock.mockResolvedValue({ error: "La credencial ya está revocada." });

    render(
      <RevokeServiceDogActions credential={CREDENTIAL} actorRole="admin" jurisdictions={[]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revocar credencial" }));
    fireEvent.change(screen.getByLabelText(/Motivo/i), { target: { value: VALID_MOTIVO } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Revocar" }));

    await waitFor(() => {
      expect(screen.getByText("La credencial ya está revocada.")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Credencial revocada/)).toBeNull();
  });
});
