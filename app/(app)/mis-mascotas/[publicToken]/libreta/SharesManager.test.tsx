// @vitest-environment jsdom
//
// SharesManager — post-mutation staleness fix (QA finding 5a, engram #635)
// + revoke confirm/box-cleanup polish (2026-07 persona validation).
//
// Revoke succeeded server-side but the in-sheet "Enlaces activos" list never
// updated (the revoked row + its "Revocar" button stayed live) because the
// list only ever came from the `shares` prop, snapshotted once by the parent
// (MergedShareSheet) on mount — revalidatePath() in the server action
// refreshes RSC trees, not this already-mounted client component's state.
//
// Fix: mirror `shares` into local state and trim the revoked row out of it
// using the server action's OWN return value (shareTokenRowId), not a
// reload/refetch.
//
// Revoke now requires a ConfirmDialog step (previously one click killed a
// live link with no confirmation, unlike the rest of the app's destructive
// actions), and revoking the just-created share also clears its "Enlace
// generado / Copiar" box instead of leaving a dead link on screen.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibretaShareToken } from "@/db/schema";

const revokeLibretaShareAction = vi.fn();
const createLibretaShareAction = vi.fn();

vi.mock("@/app/actions/libreta-share", () => ({
  createLibretaShareAction: (...args: unknown[]) => createLibretaShareAction(...args),
  revokeLibretaShareAction: (...args: unknown[]) => revokeLibretaShareAction(...args),
}));

import { SharesManager } from "./SharesManager";

// jsdom doesn't implement native <dialog>.showModal/close (ConfirmDialog
// calls them) — stubbed in OpBulkBar.test.tsx too, but that suite never
// queries the dialog's own content, so a bare no-op is enough there. Here we
// DO need to find the confirm button inside the dialog, and role="dialog"
// is only exposed while the `open` attribute is set — so these stubs also
// toggle it, same as the browser would.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

// Opens the revoke confirm dialog for a row and clicks its confirm button.
function revokeViaDialog(rowButtonName = "Revocar") {
  fireEvent.click(screen.getAllByRole("button", { name: rowButtonName })[0]);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Revocar" }));
}

function makeShare(overrides: Partial<LibretaShareToken> = {}): LibretaShareToken {
  return {
    id: "share-1",
    shareToken: "tok-1",
    petId: "pet-1",
    createdByUserId: "user-1",
    label: "Vet de cabecera",
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    viewCountCached: 0,
    lastViewedAtCached: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  revokeLibretaShareAction.mockReset();
  createLibretaShareAction.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SharesManager — revoke updates the in-sheet list without reload", () => {
  it("removes the revoked row from the active-shares list on success", async () => {
    revokeLibretaShareAction.mockResolvedValue({ ok: true, shareTokenRowId: "share-1" });
    render(<SharesManager petPublicToken="TOKEN-1" shares={[makeShare()]} />);

    expect(screen.getByText("Vet de cabecera")).toBeInTheDocument();

    revokeViaDialog();

    await waitFor(() => {
      expect(screen.queryByText("Vet de cabecera")).not.toBeInTheDocument();
    });
    expect(
      screen.getByText("No hay enlaces activos. Crea uno para compartir la libreta."),
    ).toBeInTheDocument();
  });

  it("keeps other rows when only one share is revoked", async () => {
    revokeLibretaShareAction.mockResolvedValue({ ok: true, shareTokenRowId: "share-1" });
    render(
      <SharesManager
        petPublicToken="TOKEN-1"
        shares={[makeShare(), makeShare({ id: "share-2", label: "Guardería" })]}
      />,
    );

    revokeViaDialog();

    await waitFor(() => {
      expect(screen.queryByText("Vet de cabecera")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Guardería")).toBeInTheDocument();
  });

  it("does nothing when the confirm dialog is dismissed without confirming", async () => {
    render(<SharesManager petPublicToken="TOKEN-1" shares={[makeShare()]} />);

    fireEvent.click(screen.getByRole("button", { name: "Revocar" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));

    expect(revokeLibretaShareAction).not.toHaveBeenCalled();
    expect(screen.getByText("Vet de cabecera")).toBeInTheDocument();
  });

  it("leaves the list untouched when revoke fails", async () => {
    revokeLibretaShareAction.mockResolvedValue({
      error: "Sin permisos para revocar este compartido.",
    });
    render(<SharesManager petPublicToken="TOKEN-1" shares={[makeShare()]} />);

    revokeViaDialog();

    await waitFor(() => {
      expect(screen.getByText("Sin permisos para revocar este compartido.")).toBeInTheDocument();
    });
    expect(screen.getByText("Vet de cabecera")).toBeInTheDocument();
  });
});

describe("SharesManager — create refreshes the active-shares list (O-3)", () => {
  it("asks the parent to re-fetch after a successful create", async () => {
    createLibretaShareAction.mockResolvedValue({ shareToken: "LBR-NEW1-NEW2" });
    const onShareCreated = vi.fn();
    render(<SharesManager petPublicToken="TOKEN-1" shares={[]} onShareCreated={onShareCreated} />);

    fireEvent.click(screen.getByRole("button", { name: "Nuevo enlace" }));
    fireEvent.click(screen.getByRole("button", { name: "Crear enlace" }));

    await waitFor(() => {
      expect(onShareCreated).toHaveBeenCalledTimes(1);
    });
  });

  it("does not call onShareCreated when create fails", async () => {
    createLibretaShareAction.mockResolvedValue({ error: "No se pudo crear el enlace." });
    const onShareCreated = vi.fn();
    render(<SharesManager petPublicToken="TOKEN-1" shares={[]} onShareCreated={onShareCreated} />);

    fireEvent.click(screen.getByRole("button", { name: "Nuevo enlace" }));
    fireEvent.click(screen.getByRole("button", { name: "Crear enlace" }));

    await waitFor(() => {
      expect(screen.getByText("No se pudo crear el enlace.")).toBeInTheDocument();
    });
    expect(onShareCreated).not.toHaveBeenCalled();
  });
});

describe("SharesManager — revoking the just-created share clears its generated-link box", () => {
  it("hides the 'Enlace generado' box once that same share is revoked", async () => {
    // The parent (MergedShareSheet) re-fetches after onShareCreated, so the
    // just-created share also arrives back in `shares` — simulated here by
    // rendering with a matching row already present.
    const newShare = makeShare({ id: "share-new", shareToken: "LBR-NEW1-NEW2", label: null });
    createLibretaShareAction.mockResolvedValue({ shareToken: "LBR-NEW1-NEW2" });
    revokeLibretaShareAction.mockResolvedValue({ ok: true, shareTokenRowId: "share-new" });

    render(<SharesManager petPublicToken="TOKEN-1" shares={[newShare]} />);

    fireEvent.click(screen.getByRole("button", { name: "Nuevo enlace" }));
    fireEvent.click(screen.getByRole("button", { name: "Crear enlace" }));

    await waitFor(() => {
      expect(screen.getByText("Enlace generado. Copia y envialo.")).toBeInTheDocument();
    });

    revokeViaDialog();

    await waitFor(() => {
      expect(screen.queryByText("Enlace generado. Copia y envialo.")).not.toBeInTheDocument();
    });
  });
});
