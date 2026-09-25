// @vitest-environment jsdom
//
// The "Proponer vet" form sends the catalogue row the operator picked.
//
// localidades-por-id A7. The form had two free-text boxes ("Provincia donde
// ejerce", "Localidad"), so the request carried a NAME and nothing else. For a
// name two localities of one province share (Mechita, in partido Alberti and
// in partido Bragado) the server cannot tell which one was meant — before A9 it
// filed the alphabetically first, since A9 it refuses the name and asks for a
// pick from a list this form did not have. The form now uses the same
// catalogue picker as the rules wizard, and the id travels with the pair.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ propose: [] as Array<Record<string, unknown>> }));

vi.mock("@/app/actions/admin-proposals", () => ({
  proposeVetUpgradeAction: async (input: Record<string, unknown>) => {
    calls.propose.push(input);
    return { ok: true };
  },
}));
vi.mock("@/lib/ui/action-feedback", () => ({ notifySaved: vi.fn() }));
// The picker searches the catalogue through a server action; this stub is its
// input and the one catalogue row a person picks from its results (the real
// picker lists rows labelled with their department).
const MECHITA_BRAGADO = {
  provinceCode: "AR-B",
  provinceName: "Buenos Aires",
  localityName: "Mechita",
  departmentName: "Bragado",
  indecId: "06112080",
};
vi.mock("@/components/LocalityPickerAcross", () => ({
  LocalityPickerAcross: ({
    id,
    onSelect,
  }: {
    id?: string;
    onSelect?: (r: Record<string, unknown> | null) => void;
  }) => (
    <>
      <input id={id ? `${id}-input` : undefined} readOnly />
      <select aria-label="Resultados" onChange={() => onSelect?.(MECHITA_BRAGADO)}>
        <option value="">—</option>
        <option value="06112080">Mechita (Bragado)</option>
      </select>
    </>
  ),
}));

import { ProposeUserActions } from "./ProposeUserActions";

afterEach(() => {
  cleanup();
  calls.propose = [];
});

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("Proponer vet", () => {
  it("sends the picked row's province, name and INDEC id", async () => {
    render(
      <ProposeUserActions
        target={{ id: "user-1", displayName: "Ana", role: "owner" }}
        actorRole="admin"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Proponer vet" }));
    fill("Matrícula", "MP-1234");
    fill("Jurisdicción matrícula", "Buenos Aires");
    fireEvent.change(screen.getByRole("combobox", { name: "Resultados" }), {
      target: { value: "06112080" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear solicitud" }));

    await waitFor(() => expect(calls.propose).toHaveLength(1));
    expect(calls.propose[0]).toMatchObject({
      targetUserId: "user-1",
      operationalProvince: "Buenos Aires",
      operationalLocality: "Mechita",
      operationalLocalityIndecId: "06112080",
    });
  });

  it("no longer offers free-text boxes for where the vet works", () => {
    render(
      <ProposeUserActions
        target={{ id: "user-1", displayName: "Ana", role: "owner" }}
        actorRole="admin"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Proponer vet" }));
    expect(screen.queryByLabelText("Provincia donde ejerce")).toBeNull();
    expect(screen.getByLabelText("Localidad donde ejerce")).toBeInTheDocument();
  });
});
