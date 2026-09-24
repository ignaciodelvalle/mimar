// @vitest-environment jsdom
//
// The designation form. Three of the spec's requirements are enforced HERE
// before the server ever sees the input, and each one is a different failure:
//
//   - `endsAt` REQUIRED. An arrangement with no end is not a temporary
//     caretaker, it is an undated grant of access to someone's animal. The
//     domain refuses it; the form must not let the titular reach that refusal.
//   - The 180-day cap as a picker BOUND, from the same helper the domain rule
//     uses. A picker that offers a date the action rejects is a form that lies.
//   - Nothing happens on submit failure except saying so. An invitation is
//     visible to a third party; "probably sent" is not a state this may leave
//     the titular in.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const designateAction = vi.fn();
vi.mock("@/src/modules/caretakers/actions", () => ({
  designateCaretakerAction: (...args: unknown[]) => designateAction(...args),
}));

import { DesignateCaretakerForm } from "./DesignateCaretakerForm";

const PROPS = {
  petPublicToken: "DIM-TEST-0001",
  petName: "Pampa",
  todayIso: "2026-09-01",
};

beforeEach(() => {
  designateAction.mockReset().mockResolvedValue({ grantToken: "CG-abc123" });
});

afterEach(() => cleanup());

function fill(email = "ana@example.com", endsAt = "2026-09-15") {
  fireEvent.change(screen.getByLabelText(/correo/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/hasta/i), { target: { value: endsAt } });
}

describe("the period bounds", () => {
  it("requires an end date", () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    expect(screen.getByLabelText(/hasta/i)).toBeRequired();
  });

  it("defaults the start to today and cannot start earlier", () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    const desde = screen.getByLabelText(/desde/i);
    expect(desde).toHaveValue("2026-09-01");
    expect(desde).toHaveAttribute("min", "2026-09-01");
  });

  it("caps the end-date picker at the 180th day, counting the start day", () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    expect(screen.getByLabelText(/hasta/i)).toHaveAttribute("max", "2027-02-27");
  });

  it("moves the cap when the titular moves the start date", () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    fireEvent.change(screen.getByLabelText(/desde/i), { target: { value: "2026-10-01" } });
    expect(screen.getByLabelText(/hasta/i)).toHaveAttribute("max", "2027-03-29");
    expect(screen.getByLabelText(/hasta/i)).toHaveAttribute("min", "2026-10-01");
  });

  it("names the maximum in words too — an attribute is not an explanation", () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    expect(screen.getByText(/180 días/)).toBeInTheDocument();
  });
});

describe("submitting", () => {
  it("sends exactly what the titular typed", async () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    fill();
    fireEvent.change(screen.getByLabelText(/nota/i), { target: { value: "Viaje de trabajo" } });
    fireEvent.click(screen.getByRole("button", { name: "Invitar como cuidador/a" }));

    await waitFor(() =>
      expect(designateAction).toHaveBeenCalledWith({
        petPublicToken: "DIM-TEST-0001",
        inviteeEmail: "ana@example.com",
        startsAt: "2026-09-01",
        endsAt: "2026-09-15",
        note: "Viaje de trabajo",
      }),
    );
  });

  it("sends a null note rather than an empty string", async () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Invitar como cuidador/a" }));
    await waitFor(() =>
      expect(designateAction).toHaveBeenCalledWith(expect.objectContaining({ note: null })),
    );
  });

  it("ends on a success screen naming who was invited — never a silent redirect", async () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Invitar como cuidador/a" }));
    await waitFor(() => expect(screen.getByText(/ana@example.com/)).toBeInTheDocument());
    expect(screen.getByText(/Invitación enviada/)).toBeInTheDocument();
  });

  it("says nothing happened when the action refuses", async () => {
    designateAction.mockResolvedValue({
      error: "Ya hay una invitación de cuidado pendiente para esta mascota.",
    });
    render(<DesignateCaretakerForm {...PROPS} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Invitar como cuidador/a" }));
    await waitFor(() =>
      expect(
        screen.getByText("Ya hay una invitación de cuidado pendiente para esta mascota."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Invitación enviada/)).not.toBeInTheDocument();
  });
});

describe("what the titular is told they are giving away", () => {
  it("states the scope before the invitation is sent, not after", () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    expect(screen.getByText(/Podés cargar eventos médicos/)).toBeInTheDocument();
    expect(screen.getByText(/No podés transferir/)).toBeInTheDocument();
  });

  it("says the titular keeps control — the asymmetry is the product", () => {
    render(<DesignateCaretakerForm {...PROPS} />);
    expect(screen.getByText(/Podés finalizar el cuidado cuando quieras/)).toBeInTheDocument();
  });
});
