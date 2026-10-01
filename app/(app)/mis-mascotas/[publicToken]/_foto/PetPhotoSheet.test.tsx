// @vitest-environment jsdom
//
// PetPhotoSheet — the web's photo door (owner-pet-actions, PO rule "web = app").
//
// The panel's "Foto" row and the credential's photo frame open `?sheet=foto`
// for any holder, the twin of the app's photo screen: the same words, one file,
// one Guardar, and the act decided by `updatePetPhotoAction` — not by the edit
// form a caretaker may not open.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updatePetPhotoAction = vi.fn();
vi.mock("@/app/actions/pet-photo", () => ({
  updatePetPhotoAction: (...args: unknown[]) => updatePetPhotoAction(...args),
}));

const useActionRedirect = vi.fn(() => false);
vi.mock("@/lib/ui/use-action-redirect", () => ({
  useActionRedirect: (...args: unknown[]) => useActionRedirect(...(args as [])),
}));

import { PetPhotoSheet } from "./PetPhotoSheet";

const TOKEN = "DIM-PAMP-0001";

beforeEach(() => {
  updatePetPhotoAction.mockReset();
  useActionRedirect.mockReset();
  useActionRedirect.mockReturnValue(false);
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("PetPhotoSheet — what the photo is, and the one thing to do", () => {
  it("says the photo is the credential's, and asks for one as the point of the sheet", () => {
    const { container } = render(<PetPhotoSheet petPublicToken={TOKEN} existingPhotoUrl={null} />);
    // The app's own sentence for the same screen (PetPhotoScreen).
    expect(
      screen.getByText(
        "Es la imagen de la credencial: la ve cualquiera que escanee el QR. Elegí una donde se reconozca al animal.",
      ),
    ).toBeInTheDocument();
    // Not "opcional": choosing the photo is the whole act here.
    expect(screen.queryByText("opcional")).toBeNull();
    expect(container.querySelector('input[type="file"][name="photo"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Guardar foto" })).toHaveAttribute("type", "submit");
  });

  it("shows the current photo, and the chosen one in its place", () => {
    const { container } = render(
      <PetPhotoSheet petPublicToken={TOKEN} existingPhotoUrl="https://s.test/pampa.jpg" />,
    );
    const preview = () => screen.getByAltText("Vista previa de la mascota");
    expect(preview()).toHaveAttribute("src", "https://s.test/pampa.jpg");
    const input = container.querySelector('input[name="photo"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "nueva.jpg")] } });
    expect(preview()).toHaveAttribute("src", "blob:preview");
  });
});

describe("PetPhotoSheet — the save", () => {
  it("posts the form to the photo action, for THIS pet", async () => {
    updatePetPhotoAction.mockResolvedValue({ error: null, redirectTo: `/mis-mascotas/${TOKEN}` });
    render(<PetPhotoSheet petPublicToken={TOKEN} existingPhotoUrl={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Guardar foto" }));
    await waitFor(() => expect(updatePetPhotoAction).toHaveBeenCalled());
    const [token, previous, formData] = updatePetPhotoAction.mock.calls[0] as [
      string,
      unknown,
      FormData,
    ];
    expect(token).toBe(TOKEN);
    expect(previous).toEqual({ error: null });
    expect(formData.has("photo")).toBe(true);
    // The success navigates the whole document back to the profile.
    await waitFor(() =>
      expect(useActionRedirect).toHaveBeenLastCalledWith(`/mis-mascotas/${TOKEN}`, {
        error: null,
        redirectTo: `/mis-mascotas/${TOKEN}`,
      }),
    );
  });

  it("shows the action's refusal in the sheet, where the person is", async () => {
    updatePetPhotoAction.mockResolvedValue({ error: "Elegí una foto para la credencial." });
    render(<PetPhotoSheet petPublicToken={TOKEN} existingPhotoUrl={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Guardar foto" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Elegí una foto para la credencial.",
    );
  });

  it("takes the chosen picture off the preview when the save is refused (the input was reset)", async () => {
    updatePetPhotoAction.mockResolvedValue({ error: "La foto pesa más de 5 MB." });
    const { container } = render(
      <PetPhotoSheet petPublicToken={TOKEN} existingPhotoUrl="https://s.test/pampa.jpg" />,
    );
    const input = container.querySelector('input[name="photo"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "grande.jpg")] } });
    expect(screen.getByAltText("Vista previa de la mascota")).toHaveAttribute(
      "src",
      "blob:preview",
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar foto" }));
    await screen.findByRole("alert");
    // React 19 emptied the file input; the preview must not still claim the file.
    await waitFor(() =>
      expect(screen.getByAltText("Vista previa de la mascota")).toHaveAttribute(
        "src",
        "https://s.test/pampa.jpg",
      ),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("stays busy while the document leaves, so a second tap cannot post twice", () => {
    useActionRedirect.mockReturnValue(true);
    render(<PetPhotoSheet petPublicToken={TOKEN} existingPhotoUrl={null} />);
    expect(screen.getByRole("button", { name: "Guardando…" })).toBeDisabled();
  });
});
