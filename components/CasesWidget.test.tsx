// @vitest-environment jsdom
//
// The /mis-mascotas Bandeja's casos, grouped by whose turn it is (PO decision
// 2026-10-06): "Te toca a vos" first, then "En curso", then the history
// collapsed; one pet's rows under the pet once there are two of them; an
// account-level row (a denuncia filed) on its own, with no pet.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { type CaseRow, CasesWidget } from "./CasesWidget";

afterEach(() => cleanup());

const PAMPA = {
  petId: "DIM-PAMP-0001",
  petName: "Pampa",
  petPhotoUrl: "https://storage.test/pets/pampa.jpg",
};

function row(id: string, overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id,
    title: id,
    subtitle: "",
    ctaUrl: `/casos/${id}`,
    since: new Date("2026-10-01T12:00:00.000Z"),
    severity: "info",
    icon: "nota",
    needsAction: false,
    dueAt: null,
    petId: null,
    petName: null,
    petPhotoUrl: null,
    ...overrides,
  };
}

/** A group, by its own <h3> (the section is aria-labelledby it; the count rides along). */
function group(name: string) {
  return screen.getByRole("region", { name: new RegExp(`^${name}`) });
}

describe("CasesWidget — grouped by whose turn it is", () => {
  it("draws 'Te toca a vos' before 'En curso', each with its own rows", () => {
    render(
      <CasesWidget
        open={[
          row("Denuncia de bienestar animal"),
          row("Atestá la raza de Toto", {
            needsAction: true,
            severity: "warning",
            petId: "DIM-TOTO-0002",
            petName: "Toto",
          }),
        ]}
      />,
    );
    const turn = group("Te toca a vos");
    const ongoing = group("En curso");
    expect(within(turn).getByText("Atestá la raza de Toto")).toBeInTheDocument();
    expect(within(ongoing).getByText("Denuncia de bienestar animal")).toBeInTheDocument();
    expect(turn.compareDocumentPosition(ongoing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts the earliest deadline on top and says when it lapses", () => {
    render(
      <CasesWidget
        open={[
          row("Sin plazo", { needsAction: true, since: new Date("2026-10-05T12:00:00Z") }),
          row("Plazo largo", { needsAction: true, dueAt: new Date("2026-10-30T15:00:00Z") }),
          row("Plazo corto", { needsAction: true, dueAt: new Date("2026-10-09T15:00:00Z") }),
        ]}
      />,
    );
    const titles = within(group("Te toca a vos"))
      .getAllByRole("link")
      .map((a) => a.querySelector("p")?.textContent);
    expect(titles).toEqual(["Plazo corto", "Plazo largo", "Sin plazo"]);
    expect(screen.getAllByText(/^Vence el /)).toHaveLength(2);
  });

  it("gathers one pet's cases under the pet, with a count", () => {
    render(
      <CasesWidget
        open={[
          row("Pampa está reportada como perdida", { ...PAMPA, needsAction: true }),
          row("Atestá la raza de Pampa", { ...PAMPA, needsAction: true }),
        ]}
      />,
    );
    const turn = group("Te toca a vos");
    expect(within(turn).getByText("Pampa")).toBeInTheDocument();
    expect(within(turn).getByText("· 2 casos")).toBeInTheDocument();
    // The pet heads its cluster as a real heading, not styled text.
    expect(within(turn).getByRole("heading", { level: 4, name: /^Pampa/ })).toBeInTheDocument();
    // The pet is named ONCE, at the head of its cluster, not again on each row.
    expect(within(turn).getAllByText("Pampa")).toHaveLength(1);
    expect(within(turn).getAllByRole("link")).toHaveLength(2);
    expect(turn.querySelector('img[src*="pampa.jpg"]')).not.toBeNull();
  });

  it("shows a single case with its pet's photo and name inline", () => {
    render(<CasesWidget open={[row("Tu postulación para Pampa", PAMPA)]} />);
    const link = screen.getByRole("link");
    expect(within(link).getByText("Pampa")).toBeInTheDocument();
    expect(link.querySelector('img[src*="pampa.jpg"]')).not.toBeNull();
    expect(screen.queryByText(/^· \d+ casos$/)).toBeNull();
  });

  it("draws an account-level row with no pet at all", () => {
    render(<CasesWidget open={[row("Denuncia de bienestar animal")]} />);
    const link = screen.getByRole("link");
    expect(link.querySelector("img")).toBeNull();
    expect(link).toHaveAttribute("href", "/casos/Denuncia de bienestar animal");
  });

  it("keeps the severity icon on every row", () => {
    const { container } = render(
      <CasesWidget open={[row("Urgente", { severity: "danger" }), row("Aviso")]} />,
    );
    expect(container.querySelectorAll("span[aria-hidden] svg")).toHaveLength(2);
    expect(container.querySelector(".text-ln-err")).not.toBeNull();
  });

  it("says plainly when nothing waits on the owner", () => {
    render(<CasesWidget open={[row("Denuncia de bienestar animal")]} />);
    expect(within(group("Te toca a vos")).getByText(/Nada pendiente de tu parte/)).toBeVisible();
  });

  it("does not claim 'En curso' waits on another person — a bite observation runs its course", () => {
    render(
      <CasesWidget open={[row("Observación por mordedura · Pampa", { severity: "warning" })]} />,
    );
    const ongoing = group("En curso");
    expect(within(ongoing).getByText(/Siguen su curso/)).toBeInTheDocument();
    expect(ongoing.textContent).not.toMatch(/otra persona/);
  });

  it("reads naturally when there is nothing open at all", () => {
    render(<CasesWidget open={[]} />);
    expect(screen.getByText(/No tenés casos abiertos/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Te toca a vos/ })).toBeNull();
  });

  it("keeps the history collapsed behind its summary", () => {
    const { container } = render(
      <CasesWidget open={[]} history={[row("Postulación para Luna", { petName: "Luna" })]} />,
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(within(details as HTMLElement).getByText("Historial")).toBeInTheDocument();
    expect(within(details as HTMLElement).getByText("· 1 cerrado")).toBeInTheDocument();
  });
});
