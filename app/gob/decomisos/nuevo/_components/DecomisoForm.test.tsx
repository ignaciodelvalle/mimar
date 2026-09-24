// @vitest-environment jsdom
//
// Executing a decomiso ends on its receipt (L-13). The public code IS the
// receipt — it is what the funcionario writes on the acta — and it used to be
// thrown into a router.push URL. Drives the real form down the unowned-animal
// path (no DC2 double-confirm); only the server actions are mocked.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const executeDecomisoAction = vi.fn();
vi.mock("@/app/actions/decomiso", () => ({
  executeDecomisoAction: (...args: unknown[]) => executeDecomisoAction(...args),
}));
const lookupPetForDecomisoAction = vi.fn();
vi.mock("@/app/actions/decomiso-pet-lookup", () => ({
  lookupPetForDecomisoAction: (...args: unknown[]) => lookupPetForDecomisoAction(...args),
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), refresh: vi.fn() }),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  });
});

import { DecomisoForm } from "./DecomisoForm";

const RECEIVER = {
  id: "org-receiver-1",
  displayName: "Refugio Patitas",
  orgType: "shelter",
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "Tres Arroyos",
};

beforeEach(() => {
  executeDecomisoAction.mockReset().mockResolvedValue({ ok: true, publicCode: "CASE-7Q2K-9XZ4" });
  lookupPetForDecomisoAction
    .mockReset()
    .mockResolvedValue({ found: false, error: "No encontrada." });
  routerPush.mockReset();
});

afterEach(() => cleanup());

function fillAndSubmit(container: HTMLElement) {
  fireEvent.click(screen.getByRole("button", { name: "Animal sin registrar (callejero)" }));
  fireEvent.change(screen.getByLabelText(/Especie/), { target: { value: "dog" } });
  fireEvent.change(screen.getByLabelText(/Motivo/), { target: { value: "maltrato_fisico" } });
  fireEvent.click(screen.getByRole("button", { name: /Refugio Patitas/ }));
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  const acta = new File(["acta"], "acta.jpg", { type: "image/jpeg" });
  const foto = new File(["foto"], "foto.jpg", { type: "image/jpeg" });
  fireEvent.change(fileInput, { target: { files: [acta, foto] } });
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar decomiso" }));
}

describe("executing a decomiso ends on its receipt", () => {
  it("shows the public code as the receipt, and does not navigate by itself", async () => {
    const { container } = render(
      <DecomisoForm
        receiverOrgs={[RECEIVER]}
        prefillWelfareReportId={null}
        prefillWelfareReportRef={null}
        prefillPetToken={null}
      />,
    );
    fillAndSubmit(container);
    await waitFor(() => expect(executeDecomisoAction).toHaveBeenCalled());

    expect(await screen.findByRole("heading", { name: "Decomiso registrado" })).toBeInTheDocument();
    expect(screen.getByText("Código del decomiso")).toBeInTheDocument();
    expect(screen.getByText("CASE-7Q2K-9XZ4")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Refugio Patitas recibe la propuesta de custodia y tiene 7 días para aceptarla o rechazarla. Mientras tanto, la custodia queda a cargo de tu autoridad.",
      ),
    ).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("the old redirect target survives only as the receipt's first action", async () => {
    const { container } = render(
      <DecomisoForm
        receiverOrgs={[RECEIVER]}
        prefillWelfareReportId={null}
        prefillWelfareReportRef={null}
        prefillPetToken={null}
      />,
    );
    fillAndSubmit(container);

    const first = (await screen.findAllByRole("link"))[0];
    expect(first).toHaveTextContent("Ver el caso");
    expect(first).toHaveAttribute("href", "/casos/CASE-7Q2K-9XZ4?origin=decomiso");
    expect(screen.getByRole("link", { name: "Volver a decomisos" })).toHaveAttribute(
      "href",
      "/gob/decomisos",
    );
  });

  it("a delivery warning is shown ON the receipt, not lost behind a navigation", async () => {
    executeDecomisoAction.mockResolvedValue({
      ok: true,
      publicCode: "CASE-7Q2K-9XZ4",
      warning: "No pudimos avisarle al refugio.",
    });
    const { container } = render(
      <DecomisoForm
        receiverOrgs={[RECEIVER]}
        prefillWelfareReportId={null}
        prefillWelfareReportRef={null}
        prefillPetToken={null}
      />,
    );
    fillAndSubmit(container);

    expect(await screen.findByRole("heading", { name: "Decomiso registrado" })).toBeInTheDocument();
    expect(screen.getByText("No pudimos avisarle al refugio.")).toBeInTheDocument();
  });

  it("an error keeps the form and shows it", async () => {
    executeDecomisoAction.mockResolvedValue({ error: "No se pudo registrar." });
    const { container } = render(
      <DecomisoForm
        receiverOrgs={[RECEIVER]}
        prefillWelfareReportId={null}
        prefillWelfareReportRef={null}
        prefillPetToken={null}
      />,
    );
    fillAndSubmit(container);

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo registrar.");
    expect(screen.queryByRole("heading", { name: "Decomiso registrado" })).toBeNull();
  });
});

// The petPublicToken field used to run the browser's Unicode `toUpperCase()`,
// which turns lookalikes (Turkish dotless `ı` -> `I`) into a real token shape.
// It now goes through the shared ASCII-only normaliser (lib/domain/dim-token.ts).
describe("the pet token field normalizes with the shared ASCII normaliser", () => {
  it("uppercases only a-z and leaves a non-ASCII lookalike untouched, then looks up the typed shape", async () => {
    render(
      <DecomisoForm
        receiverOrgs={[RECEIVER]}
        prefillWelfareReportId={null}
        prefillWelfareReportRef={null}
        prefillPetToken={null}
      />,
    );

    const input = screen.getByLabelText("Token de la mascota");
    // "dım-pamp-0001" with a Turkish dotless ı: a real `toUpperCase()` would
    // turn ı into I, producing the valid-looking "DIM-PAMP-0001". The ASCII
    // normaliser only folds a-z, so ı is left exactly as typed — "DıM-PAMP-0001",
    // visibly not a real token.
    fireEvent.change(input, { target: { value: "dım-pamp-0001" } });
    expect(input).toHaveValue("DıM-PAMP-0001");

    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(lookupPetForDecomisoAction).toHaveBeenCalledWith("DıM-PAMP-0001"));
  });
});

// Bucket `decomiso-evidence` (0234, PO decision D10): JPG/PNG/WEBP photos
// and the PDF acta, up to 10 MB each and 45 MB together.
describe("attachments only accept what the bucket stores", () => {
  function renderForm() {
    return render(
      <DecomisoForm
        receiverOrgs={[RECEIVER]}
        prefillWelfareReportId={null}
        prefillWelfareReportRef={null}
        prefillPetToken={null}
      />,
    );
  }
  const fileInput = (container: HTMLElement) =>
    container.querySelector('input[type="file"]') as HTMLInputElement;

  it("accepts a PDF acta and offers PDF in the picker", async () => {
    const { container } = renderForm();
    expect(fileInput(container).accept).toBe("image/jpeg,image/png,image/webp,application/pdf");
    const acta = new File(["%PDF-1.7"], "acta.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput(container), { target: { files: [acta] } });

    expect(await screen.findByText("acta.pdf")).toBeInTheDocument();
    expect(screen.queryByText(/Tipo no permitido/)).toBeNull();
    expect(
      screen.getByText(/Hasta 10 archivos JPG, PNG, WEBP o PDF de hasta 10 MB cada uno/),
    ).toBeInTheDocument();
  });

  it("rejects a type the bucket does not store, and never calls the action", async () => {
    const { container } = renderForm();
    const zip = new File(["PK"], "acta.zip", { type: "application/zip" });
    fireEvent.change(fileInput(container), { target: { files: [zip] } });

    expect(
      await screen.findByText(
        'Tipo no permitido: "acta.zip". Aceptamos imágenes JPG, PNG o WEBP y actas en PDF.',
      ),
    ).toBeInTheDocument();
    expect(executeDecomisoAction).not.toHaveBeenCalled();
  });

  it("rejects a file over 10 MB, and never calls the action", async () => {
    const { container } = renderForm();
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "acta.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(fileInput(container), { target: { files: [big] } });

    expect(await screen.findByText('"acta.pdf" supera el límite de 10 MB.')).toBeInTheDocument();
    expect(executeDecomisoAction).not.toHaveBeenCalled();
  });

  it("accepts a file of exactly 10 MB", async () => {
    const { container } = renderForm();
    const edge = new File([new Uint8Array(10 * 1024 * 1024)], "acta.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(fileInput(container), { target: { files: [edge] } });

    expect(await screen.findByText("acta.pdf")).toBeInTheDocument();
    expect(screen.queryByText(/supera el límite/)).toBeNull();
  });

  it("rejects files that together pass 45 MB, before the request would", async () => {
    const { container } = renderForm();
    const files = Array.from(
      { length: 5 },
      (_, i) =>
        new File([new Uint8Array(10 * 1024 * 1024)], `acta-${i}.pdf`, {
          type: "application/pdf",
        }),
    );
    fireEvent.change(fileInput(container), { target: { files } });

    expect(await screen.findByText("Los archivos juntos superan los 45 MB.")).toBeInTheDocument();
    expect(executeDecomisoAction).not.toHaveBeenCalled();
  });
});
