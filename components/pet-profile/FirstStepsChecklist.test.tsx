// @vitest-environment jsdom
//
// FirstStepsChecklist — "Primeros pasos" onboarding checklist rows. Covers:
// rendering pending items, each row's action link, and the "Omitir" dismiss
// interaction (optimistic-terminal: the row hides immediately on success).

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { dismissFirstStepAction } = vi.hoisted(() => ({
  dismissFirstStepAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/app/actions/pet-onboarding", () => ({ dismissFirstStepAction }));

import type { FirstStepItem } from "@/lib/projections/first-steps-checklist";
import { FirstStepsChecklist } from "./FirstStepsChecklist";

const ITEMS: FirstStepItem[] = [
  {
    key: "disclosure_prefs",
    label: "Decidí qué se muestra si se pierde",
    actionHref: "/mis-mascotas/DIM-PAMP-0001?sheet=privacidad",
    actionLabel: "Revisar",
    star: true,
  },
  {
    key: "photo",
    label: "Agregá una foto",
    actionHref: "/mis-mascotas/DIM-PAMP-0001?sheet=editar-mascota",
    actionLabel: "Agregar",
  },
];

afterEach(() => {
  cleanup();
  dismissFirstStepAction.mockClear();
});

describe("<FirstStepsChecklist>", () => {
  it("renders every pending item with its label and action link", () => {
    render(<FirstStepsChecklist items={ITEMS} petPublicToken="DIM-PAMP-0001" />);

    expect(screen.getByText("Decidí qué se muestra si se pierde")).toBeInTheDocument();
    expect(screen.getByText("Agregá una foto")).toBeInTheDocument();

    const photoLink = screen.getByRole("link", { name: "Agregar →" });
    expect(photoLink).toHaveAttribute("href", "/mis-mascotas/DIM-PAMP-0001?sheet=editar-mascota");
  });

  it("renders nothing when the item list is empty", () => {
    const { container } = render(<FirstStepsChecklist items={[]} petPublicToken="DIM-PAMP-0001" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("dismissing a row calls the action with (token, key) and removes it, keeping the rest", async () => {
    render(<FirstStepsChecklist items={ITEMS} petPublicToken="DIM-PAMP-0001" />);

    const omitButtons = screen.getAllByRole("button", { name: /omitir/i });
    fireEvent.click(omitButtons[1]); // "Agregá una foto" row

    await waitFor(() => {
      expect(dismissFirstStepAction).toHaveBeenCalledWith("DIM-PAMP-0001", "photo");
    });
    await waitFor(() => {
      expect(screen.queryByText("Agregá una foto")).not.toBeInTheDocument();
    });
    // The other row stays gone are not dismissed — it survives.
    expect(screen.getByText("Decidí qué se muestra si se pierde")).toBeInTheDocument();
  });

  it("dismissing every remaining item empties the list (component renders null)", async () => {
    const singleItem = [ITEMS[1]];
    const { container } = render(
      <FirstStepsChecklist items={singleItem} petPublicToken="DIM-PAMP-0001" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /omitir/i }));

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });
});
