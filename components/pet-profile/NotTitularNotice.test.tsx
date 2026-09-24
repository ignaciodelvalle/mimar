// @vitest-environment jsdom
//
// The refusal a caretaker reads instead of a 404.
//
// This component exists because of a specific failure mode the spec calls out
// twice: "never a 404 a person discovers by clicking". A caretaker IS a
// legitimate holder of the pet. Rendering notFound() at them says the animal
// they are caring for does not exist — which is both false and unrecoverable,
// because there is nothing on a 404 page to act on.
//
// Every instance must therefore do three things, and the tests below are those
// three things: name what is refused, say what the person CAN still do, and
// leave a way back.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NotTitularNotice } from "./NotTitularNotice";

afterEach(() => cleanup());

describe("NotTitularNotice", () => {
  it("names the specific thing that is refused", () => {
    render(
      <NotTitularNotice petPublicToken="DIM-TEST-0001" what="Editar los datos de la mascota" />,
    );
    expect(screen.getByText(/Editar los datos de la mascota/)).toBeInTheDocument();
  });

  it("says it is the TITULAR's action — not that something went wrong", () => {
    render(<NotTitularNotice petPublicToken="DIM-TEST-0001" what="Registrar una mudanza" />);
    expect(screen.getByText(/solo la puede hacer el titular/i)).toBeInTheDocument();
  });

  it("states what the caretaker CAN still do, so the refusal is not a dead end", () => {
    render(<NotTitularNotice petPublicToken="DIM-TEST-0001" what="Registrar una mudanza" />);
    expect(screen.getByText(/eventos médicos/)).toBeInTheDocument();
  });

  it("always leaves a way back to the pet", () => {
    render(<NotTitularNotice petPublicToken="DIM-TEST-0001" what="Registrar una mudanza" />);
    expect(screen.getByRole("link", { name: /libreta/i })).toHaveAttribute(
      "href",
      "/mis-mascotas/DIM-TEST-0001",
    );
  });

  it("accepts an explicit reason from the guard instead of inventing one", () => {
    render(
      <NotTitularNotice
        petPublicToken="DIM-TEST-0001"
        what="Registrar una mudanza"
        reason="Sos cuidador/a de esta mascota. Esta acción es solo del titular."
      />,
    );
    expect(
      screen.getByText(/Sos cuidador\/a de esta mascota\. Esta acción es solo del titular\./),
    ).toBeInTheDocument();
  });
});
