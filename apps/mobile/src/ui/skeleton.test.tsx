// Skeletons — the two promises worth pinning.
//
// A composite announces itself ONCE and hides its bones: a screen reader must
// hear "Cargando tus turnos" exactly as the spinner it replaced said it, and
// never a page of unlabeled rectangles. And the row count is the caller's —
// the placeholder claims the shape of what is coming.

import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";

import { CardSkeleton, ListSkeleton } from "./skeleton";

describe("ListSkeleton", () => {
  it("announces the loading sentence once, on the container", () => {
    render(<ListSkeleton rows={3} label="Cargando tus turnos…" />);
    expect(screen.getByLabelText("Cargando tus turnos…")).toBeOnTheScreen();
  });

  it("hides the bones from assistive tech — the label is the whole announcement", () => {
    render(<ListSkeleton rows={2} label="Cargando…" />);
    // The layer that swallows its descendants must exist between the labeled
    // container and the bones. UNSAFE_* because the mobile convention is no
    // testIDs — production stays a11y-only, the test reaches under it.
    expect(
      screen.UNSAFE_getAllByProps({ importantForAccessibility: "no-hide-descendants" }).length,
    ).toBeGreaterThan(0);
  });

  it("renders as many card placeholders as the caller promised rows", () => {
    render(<ListSkeleton rows={4} label="Cargando…" />);
    expect(screen.UNSAFE_getAllByType(CardSkeleton)).toHaveLength(4);
  });
});

describe("CardSkeleton", () => {
  it("renders without crashing — the atom's animation is decoration, not contract", () => {
    expect(() => render(<CardSkeleton />)).not.toThrow();
  });
});
