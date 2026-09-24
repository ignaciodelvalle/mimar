// @vitest-environment jsdom
//
// The RUPPPA export button (L-11): present for an eligible owner, absent — with
// the reason in words — when the pet is outside CABA; the PDF arrives as a
// download link (no window.open after an await: popup blockers eat it), and the
// use-case's error codes reach the owner in Spanish, never as codes.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generatePppExportAction = vi.fn();
vi.mock("@/app/actions/ppp-export-caba", () => ({
  generatePppExportAction: (...args: unknown[]) => generatePppExportAction(...args),
}));

import { PppExportAffordance } from "./PppExportAffordance";

const BUTTON = "Emitir constancia RUPPPA (PDF)";

beforeEach(() => {
  generatePppExportAction.mockReset();
});

afterEach(() => cleanup());

describe("eligible owner (CABA)", () => {
  it("renders the button", () => {
    render(
      <PppExportAffordance petPublicToken="DIM-PPP-0001" availability={{ kind: "available" }} />,
    );
    expect(screen.getByRole("button", { name: BUTTON })).toBeInTheDocument();
  });

  it("emitting turns into a download link to the signed URL", async () => {
    generatePppExportAction.mockResolvedValue({
      ok: true,
      signedUrl: "https://storage.example/ppp-exports/DIM-PPP-0001/caba/1.pdf?token=x",
      expiresAt: new Date("2026-09-19T12:00:00Z"),
    });
    render(
      <PppExportAffordance petPublicToken="DIM-PPP-0001" availability={{ kind: "available" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUTTON }));

    await waitFor(() => expect(generatePppExportAction).toHaveBeenCalledWith("DIM-PPP-0001"));
    const link = await screen.findByRole("link", { name: "Descargar la constancia RUPPPA (PDF)" });
    expect(link).toHaveAttribute(
      "href",
      "https://storage.example/ppp-exports/DIM-PPP-0001/caba/1.pdf?token=x",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(
      screen.getByText("El enlace vale 24 horas. Después, generala de nuevo desde acá."),
    ).toBeInTheDocument();
  });

  it("a use-case error code reaches the owner in words, and the button stays", async () => {
    generatePppExportAction.mockResolvedValue({ ok: false, error: "pet_not_ppp_for_jurisdiction" });
    render(
      <PppExportAffordance petPublicToken="DIM-PPP-0001" availability={{ kind: "available" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUTTON }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Esta mascota no figura como potencialmente peligrosa.",
    );
    expect(screen.getByRole("button", { name: BUTTON })).toBeInTheDocument();
  });

  it("an infrastructure failure gets the generic retry message", async () => {
    generatePppExportAction.mockResolvedValue({ ok: false, error: "storage_upload_failed" });
    render(
      <PppExportAffordance petPublicToken="DIM-PPP-0001" availability={{ kind: "available" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUTTON }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No pudimos generar el PDF. Probá de nuevo en unos minutos.",
    );
  });
});

describe("not eligible", () => {
  it("outside CABA: no button, and the reason in words", () => {
    render(
      <PppExportAffordance
        petPublicToken="DIM-PPP-0001"
        availability={{ kind: "unavailable", reason: "Motivo de prueba." }}
      />,
    );
    expect(screen.queryByRole("button", { name: BUTTON })).toBeNull();
    expect(screen.getByText("Motivo de prueba.")).toBeInTheDocument();
    expect(generatePppExportAction).not.toHaveBeenCalled();
  });
});
