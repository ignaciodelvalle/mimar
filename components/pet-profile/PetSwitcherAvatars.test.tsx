// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type AvatarSwitcherPet, PetSwitcherAvatars } from "./PetSwitcherAvatars";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const PETS: AvatarSwitcherPet[] = [
  { token: "DIM-LOST-0001", status: "lost", name: "Firulais", photoUrl: null },
  { token: "DIM-PREG-0002", status: "pregnant", name: "Michi", photoUrl: "https://x/2.png" },
  { token: "DIM-OKAY-0003", status: "ok", name: "Rocco", photoUrl: "https://x/3.png" },
];

afterEach(() => {
  cleanup();
  push.mockClear();
});

describe("PetSwitcherAvatars", () => {
  it("marks the current pet with aria-current and navigates on tapping another", () => {
    render(<PetSwitcherAvatars pets={PETS} currentToken="DIM-PREG-0002" />);
    const buttons = screen.getAllByRole("button");

    // Current pet carries aria-current; tapping it is a no-op.
    const current = buttons.find((b) => b.getAttribute("aria-current") === "true")!;
    expect(current).toHaveAttribute("aria-label", expect.stringContaining("Michi"));
    fireEvent.click(current);
    expect(push).not.toHaveBeenCalled();

    // Tapping another navigates to its route.
    const other = buttons.find((b) => b.getAttribute("aria-label")?.includes("Rocco"))!;
    fireEvent.click(other);
    expect(push).toHaveBeenCalledWith("/mis-mascotas/DIM-OKAY-0003");
  });

  it("names each pet in its accessible label (identity, not just position)", () => {
    render(<PetSwitcherAvatars pets={PETS} currentToken="DIM-LOST-0001" />);
    expect(screen.getByLabelText(/Firulais — mascota 1 de 3 \(actual\)/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Rocco — mascota 3 de 3/)).toBeInTheDocument();
  });

  it("shows a visible +N chip when the household exceeds the shown set", () => {
    const { container } = render(
      <PetSwitcherAvatars pets={PETS} currentToken="DIM-LOST-0001" liveTotal={6} />,
    );
    // 3 shown of 6 → "+3" chip + the honest aria-label on the group.
    expect(container.textContent).toContain("+3");
    expect(screen.getByLabelText("Tus mascotas: mostrando 3 de 6")).toBeInTheDocument();
  });

  it("shows no +N chip when the whole household fits", () => {
    const { container } = render(<PetSwitcherAvatars pets={PETS} currentToken="DIM-LOST-0001" />);
    expect(container.textContent).not.toContain("+");
    expect(screen.getByLabelText("Tus mascotas")).toBeInTheDocument();
  });
});
