// @vitest-environment jsdom
//
// Interaction tests for the bulk-intake CSV wizard (org-pilot-pack A5),
// mirroring IntakeForm.interaction.test.tsx: real component, mocked server
// actions. Pins the spec's UI contract: preview split "Válidas (N)" / "Con
// errores (M)", duplicate warning badge, confirm disabled at zero valid
// (spec 1.9), sequential chunks of 5 (design D3), per-row report, and the
// failed-rows CSV re-download (spec 1.6).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportIntakeRowResult, IntakeCsvRowPreview } from "./actions";

const validateMock = vi.fn();
const importMock = vi.fn();

vi.mock("./actions", () => ({
  validateIntakeCsvAction: (...args: unknown[]) => validateMock(...args),
  importIntakeRowsAction: (...args: unknown[]) => importMock(...args),
}));

import { ImportWizard } from "./ImportWizard";

const FILE_HASH = "a".repeat(64);

function previewRow(
  index: number,
  overrides: Partial<IntakeCsvRowPreview> = {},
): IntakeCsvRowPreview {
  return {
    index,
    record: { "nombre*": `Animal ${index + 1}`, "especie*": "perro" },
    fields: {
      name: `Animal ${index + 1}`,
      species: "dog",
      intakeReason: "rescue",
      occurredAt: "2026-07-01",
      custodyRole: "shelter_custody",
    },
    valid: true,
    errors: [],
    duplicate: false,
    ...overrides,
  };
}

function selectCsvFile() {
  const file = new File(["nombre*;especie*\r\nAnimal 1;perro\r\n"], "import.csv", {
    type: "text/csv",
  });
  fireEvent.change(screen.getByLabelText("Archivo CSV"), { target: { files: [file] } });
}

beforeEach(() => {
  validateMock.mockReset();
  importMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("<ImportWizard> — preview", () => {
  it("renders the valid/invalid split with named errors and the duplicate badge", async () => {
    validateMock.mockResolvedValue({
      ok: true,
      fileHash: FILE_HASH,
      rows: [
        previewRow(0),
        previewRow(1, {
          valid: false,
          errors: ["especie: valor inválido «conejo» (opciones: perro, gato, otra)"],
        }),
        previewRow(2, { duplicate: true }),
      ],
    });

    render(<ImportWizard orgToken="ORG-TEST-0001" />);
    selectCsvFile();

    await waitFor(() => {
      expect(screen.getByText("Válidas (2)")).toBeInTheDocument();
    });
    expect(screen.getByText("Con errores (1)")).toBeInTheDocument();
    expect(
      screen.getByText("especie: valor inválido «conejo» (opciones: perro, gato, otra)"),
    ).toBeInTheDocument();
    // Duplicate warning is distinct from hard errors and does not block.
    expect(screen.getByText("Fila duplicada dentro del archivo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar importación" })).toBeEnabled();
  });

  it("disables Confirmar importación when zero rows are valid (spec 1.9)", async () => {
    validateMock.mockResolvedValue({
      ok: true,
      fileHash: FILE_HASH,
      rows: [previewRow(0, { valid: false, errors: ["nombre: falta el valor"] })],
    });

    render(<ImportWizard orgToken="ORG-TEST-0001" />);
    selectCsvFile();

    await waitFor(() => {
      expect(screen.getByText("Con errores (1)")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Confirmar importación" })).toBeDisabled();
    // The error CSV is still downloadable to fix and re-upload.
    expect(screen.getByRole("button", { name: "Descargar filas con error" })).toBeEnabled();
  });

  it("surfaces a validate error without leaving the upload step", async () => {
    validateMock.mockResolvedValue({ error: "El archivo supera el límite de 512 KB." });

    render(<ImportWizard orgToken="ORG-TEST-0001" />);
    selectCsvFile();

    await waitFor(() => {
      expect(screen.getByText("El archivo supera el límite de 512 KB.")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Archivo CSV")).toBeInTheDocument();
  });
});

describe("<ImportWizard> — confirm, chunking and report", () => {
  it("submits ONLY valid rows in sequential chunks of 5 and renders the per-row report", async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => previewRow(i)),
      previewRow(6, { valid: false, errors: ["nombre: falta el valor"] }),
    ];
    validateMock.mockResolvedValue({ ok: true, fileHash: FILE_HASH, rows });
    importMock.mockImplementation(
      async (_orgToken: string, input: { rows: { index: number }[] }) => ({
        ok: true,
        results: input.rows.map((r): ImportIntakeRowResult => {
          if (r.index === 1) {
            return { index: r.index, outcome: "failed", reason: "Error transitorio" };
          }
          if (r.index === 2) {
            return {
              index: r.index,
              outcome: "skipped",
              reason: "Posible coincidencia por tatuaje — requiere verificación por foto",
            };
          }
          return {
            index: r.index,
            outcome: "imported",
            petToken: `DIM-TEST-${r.index}`,
            petName: `Animal ${r.index + 1}`,
          };
        }),
      }),
    );

    render(<ImportWizard orgToken="ORG-TEST-0001" />);
    selectCsvFile();
    await waitFor(() => {
      expect(screen.getByText("Válidas (6)")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirmar importación" }));

    await waitFor(() => {
      expect(screen.getByText("Resultado de la importación")).toBeInTheDocument();
    });

    // Chunks of 5: 6 valid rows → two sequential calls (5 + 1). The invalid
    // row (index 6) was NEVER submitted — not even implicitly (spec 1.4).
    expect(importMock).toHaveBeenCalledTimes(2);
    expect(importMock.mock.calls[0][1].rows).toHaveLength(5);
    expect(importMock.mock.calls[1][1].rows).toHaveLength(1);
    const submittedIndexes = importMock.mock.calls.flatMap((c) =>
      (c[1] as { rows: { index: number }[] }).rows.map((r) => r.index),
    );
    expect(submittedIndexes).toEqual([0, 1, 2, 3, 4, 5]);

    // Report: imported with ficha link, failed with reason, skipped with reason.
    expect(screen.getByText("Importada — Animal 1")).toBeInTheDocument();
    expect(screen.getByText("Falló: Error transitorio")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Salteada: Posible coincidencia por tatuaje — requiere verificación por foto",
      ),
    ).toBeInTheDocument();
    const fichaLinks = screen.getAllByRole("link", { name: "Ver ficha" });
    expect(fichaLinks[0]).toHaveAttribute("href", "/org/ORG-TEST-0001/mascotas/DIM-TEST-0");
  });

  it("failed-rows CSV re-download carries original data + errors (spec 1.6)", async () => {
    validateMock.mockResolvedValue({
      ok: true,
      fileHash: FILE_HASH,
      rows: [
        previewRow(0),
        previewRow(1, {
          record: { "nombre*": "Fallida", "especie*": "conejo" },
          valid: false,
          errors: ["especie: valor inválido «conejo»"],
        }),
      ],
    });
    importMock.mockResolvedValue({
      ok: true,
      results: [{ index: 0, outcome: "imported", petToken: "DIM-TEST-0", petName: "Animal 1" }],
    });

    const createObjectURL = vi.fn((_blob: Blob) => "blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));

    render(<ImportWizard orgToken="ORG-TEST-0001" />);
    selectCsvFile();
    await waitFor(() => {
      expect(screen.getByText("Válidas (1)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar importación" }));
    await waitFor(() => {
      expect(screen.getByText("Resultado de la importación")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Descargar filas con error" }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    const text = await blob.text();
    // Template layout + error column, original values preserved.
    expect(text).toContain("nombre*");
    expect(text).toContain("errores");
    expect(text).toContain("Fallida");
    expect(text).toContain("conejo");
    expect(text).toContain("valor inválido");

    vi.unstubAllGlobals();
  });
});

describe("<ImportWizard> — a tanda that throws (L-15)", () => {
  it("stops on the report with the rows already written and says how to resume", async () => {
    // 12 valid rows → tandas of 5, 5, 2. The first commits; the second's CALL
    // throws (network cut); the third must never be sent.
    const rows = Array.from({ length: 12 }, (_, i) => previewRow(i));
    validateMock.mockResolvedValue({ ok: true, fileHash: FILE_HASH, rows });
    importMock
      .mockImplementationOnce(async (_orgToken: string, input: { rows: { index: number }[] }) => ({
        ok: true,
        results: input.rows.map(
          (r): ImportIntakeRowResult => ({
            index: r.index,
            outcome: "imported",
            petToken: `DIM-TEST-${r.index}`,
            petName: `Animal ${r.index + 1}`,
          }),
        ),
      }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<ImportWizard orgToken="ORG-TEST-0001" />);
    selectCsvFile();
    await waitFor(() => {
      expect(screen.getByText("Válidas (12)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar importación" }));

    // Not "Importando…" forever: it lands on the report.
    await waitFor(() => {
      expect(screen.getByText("Resultado de la importación")).toBeInTheDocument();
    });
    expect(screen.queryByText(/Importando…/)).toBeNull();
    expect(importMock).toHaveBeenCalledTimes(2);

    // The five rows already written are still reported, with their fichas.
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Importada — Animal ${i}`)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("link", { name: "Ver ficha" })).toHaveLength(5);

    // The honest state: where it stopped, how many are unconfirmed, and how to
    // finish without duplicates.
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("La importación se cortó en la tanda 2 de 3.");
    expect(alert).toHaveTextContent("Quedan 7 filas sin confirmar");
    expect(alert).toHaveTextContent(
      "volvé a subir el mismo archivo, sin modificarlo. Las filas sin chip ni tatuaje que ya quedaron registradas se reconocen solas y no se duplican",
    );
    // The bug this test now also pins: a row WITH chip/tattoo that was already
    // written does NOT re-appear as "importada" on re-upload — the identifier
    // precheck rejects it as a possible match, and the banner must say so
    // instead of promising a re-import label these rows will never show.
    expect(alert).toHaveTextContent(
      'Las filas CON chip o tatuaje que ya se cargaron van a aparecer con un error de "posible coincidencia" en vez de como importadas',
    );
    expect(alert).toHaveTextContent("no las cargues de nuevo a mano por el formulario individual");

    // Resuming goes back to the upload step.
    fireEvent.click(screen.getByRole("button", { name: "Volver a subir el archivo" }));
    expect(screen.getByLabelText("Archivo CSV")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a throw on the first tanda says nothing was confirmed", async () => {
    validateMock.mockResolvedValue({
      ok: true,
      fileHash: FILE_HASH,
      rows: [previewRow(0), previewRow(1)],
    });
    importMock.mockRejectedValueOnce(new Error("lambda killed"));

    render(<ImportWizard orgToken="ORG-TEST-0001" />);
    selectCsvFile();
    await waitFor(() => {
      expect(screen.getByText("Válidas (2)")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar importación" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("La importación se cortó en la tanda 1 de 1.");
    expect(alert).toHaveTextContent("No llegamos a confirmar ninguna fila antes del corte.");
    expect(alert).toHaveTextContent("Quedan 2 filas sin confirmar");
  });

  it("a validation call that throws shows an error instead of hanging", async () => {
    validateMock.mockRejectedValueOnce(new Error("socket hang up"));

    render(<ImportWizard orgToken="ORG-TEST-0001" />);
    selectCsvFile();

    expect(
      await screen.findByText(
        "No pudimos validar el archivo. No se importó nada. Probá de nuevo en unos minutos.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Validando el archivo…")).toBeNull();
  });
});
