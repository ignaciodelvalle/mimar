// @vitest-environment jsdom
//
// PetCredentialCarousel interaction tests (owner-ia-redesign P4; slimmed by
// tarjeta-todo). The shell is INVISIBLE — the position dots live in
// PetSwitcherDots, mounted by page.tsx ABOVE this shell (PO correction
// 2026-07-18; PetSwitcherDots.test.tsx covers them) and the desktop
// arrows died with the top chrome strip. This file drives what the shell
// still owns: keyboard ←/→ navigation (with end-clamp and the tab/dialog
// guards), the constrained pointer swipe (zone-gated, sheet-gated), and the
// one-neighbor-each-side prefetch. next/navigation is mocked to observe
// router.push / router.prefetch — the exact calls the swipe / key paths make.
//
// Owner-only gating (no shell for a non-owner) is proven purely in
// lib/domain/owner-carousel.test.ts (shouldShowCarousel): the page never
// mounts this component for a non-owner.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CarouselPet } from "@/lib/domain/owner-carousel";
import { PetCredentialCarousel } from "./PetCredentialCarousel";

const { push, prefetch } = vi.hoisted(() => ({ push: vi.fn(), prefetch: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, prefetch }),
}));

const PETS: CarouselPet[] = [
  { token: "DIM-LOST-0001", status: "lost" },
  { token: "DIM-PREG-0002", status: "pregnant" },
  { token: "DIM-OKAY-0003", status: "ok" },
];

function renderCarousel(currentToken: string, pets: CarouselPet[] = PETS) {
  return render(
    <PetCredentialCarousel pets={pets} currentToken={currentToken}>
      {/* The real document marks its identity band as the swipe zone
          (CredentialFace) — this stub plays that role. */}
      <div data-testid="document" data-swipe-zone>
        documento
      </div>
    </PetCredentialCarousel>,
  );
}

afterEach(() => {
  cleanup();
  push.mockClear();
  prefetch.mockClear();
});

describe("PetCredentialCarousel — invisible shell (tarjeta-todo)", () => {
  it("renders no chrome of its own — no nav strip, no arrows, no cap text", () => {
    const { container, queryByText } = renderCarousel("DIM-PREG-0002");
    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelector("[data-testid='pet-carousel-chrome']")).toBeNull();
    expect(queryByText(/Mostrando/)).toBeNull();
    expect(queryByText(/Mascota anterior|Mascota siguiente/)).toBeNull();
  });

  it("renders the server document as children", () => {
    const { getByTestId } = renderCarousel("DIM-PREG-0002");
    expect(getByTestId("document")).toHaveTextContent("documento");
  });
});

describe("PetCredentialCarousel — keyboard navigation (clamp at ends, no wrap)", () => {
  it("ArrowRight goes to the next pet, ArrowLeft to the previous", () => {
    renderCarousel("DIM-PREG-0002");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(push).toHaveBeenCalledWith("/mis-mascotas/DIM-OKAY-0003");
    push.mockClear();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(push).toHaveBeenCalledWith("/mis-mascotas/DIM-LOST-0001");
  });

  it("ArrowLeft at the first pet is a no-op (clamp — does not wrap to the last)", () => {
    renderCarousel("DIM-LOST-0001");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(push).not.toHaveBeenCalled();
  });

  it("ArrowRight at the last pet is a no-op (clamp — does not wrap to the first)", () => {
    renderCarousel("DIM-OKAY-0003");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(push).not.toHaveBeenCalled();
  });

  it("ignores arrow keys originating from a roving tablist", () => {
    const { container } = renderCarousel("DIM-PREG-0002");
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    container.appendChild(tab);
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    expect(push).not.toHaveBeenCalled();
  });
});

describe("PetCredentialCarousel — pointer swipe (zone-gated, sheet-gated)", () => {
  it("navigates on a horizontal swipe that starts in a swipe zone (no sheet open)", () => {
    const { getByTestId } = renderCarousel("DIM-PREG-0002");
    const zone = getByTestId("document");
    // Swipe left (dx negative, clears the 48px threshold) → NEXT (less urgent).
    fireEvent.pointerDown(zone, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(zone, { clientX: 40, clientY: 100 });
    expect(push).toHaveBeenCalledWith("/mis-mascotas/DIM-OKAY-0003");
  });

  it("ignores the same gesture when it starts OUTSIDE a swipe zone", () => {
    const { container, getByTestId } = renderCarousel("DIM-PREG-0002");
    const outside = document.createElement("div");
    container.firstElementChild?.appendChild(outside);
    fireEvent.pointerDown(outside, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(getByTestId("document"), { clientX: 40, clientY: 100 });
    expect(push).not.toHaveBeenCalled();
  });

  it("does NOT navigate on the same swipe while a dialog/sheet is open", () => {
    const { getByTestId } = renderCarousel("DIM-PREG-0002");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    const zone = getByTestId("document");
    fireEvent.pointerDown(zone, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(zone, { clientX: 40, clientY: 100 });
    expect(push).not.toHaveBeenCalled();
    dialog.remove();
  });

  it("does NOT navigate while a Vaul drawer is mounted", () => {
    const { getByTestId } = renderCarousel("DIM-PREG-0002");
    const drawer = document.createElement("div");
    drawer.setAttribute("data-vaul-drawer", "");
    document.body.appendChild(drawer);
    const zone = getByTestId("document");
    fireEvent.pointerDown(zone, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(zone, { clientX: 40, clientY: 100 });
    expect(push).not.toHaveBeenCalled();
    drawer.remove();
  });

  it("does NOT navigate while a native <dialog open> is mounted (ConfirmDialog has no explicit role)", () => {
    // W1 review fix bar 2026-07-15: ConfirmDialog (components/ui/ConfirmDialog)
    // renders a bare native <dialog> — no role="dialog" attribute, since the
    // element already carries implicit ARIA dialog semantics. The gate selector
    // used to miss it entirely, so a swipe over an open ConfirmDialog could
    // still navigate to a neighbor pet mid-confirmation.
    const { getByTestId } = renderCarousel("DIM-PREG-0002");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    const zone = getByTestId("document");
    fireEvent.pointerDown(zone, { clientX: 200, clientY: 100 });
    fireEvent.pointerUp(zone, { clientX: 40, clientY: 100 });
    expect(push).not.toHaveBeenCalled();
    dialog.remove();
  });
});

describe("PetCredentialCarousel — prefetch exactly one neighbor each side", () => {
  it("prefetches both neighbors in the middle", () => {
    renderCarousel("DIM-PREG-0002");
    expect(prefetch).toHaveBeenCalledWith("/mis-mascotas/DIM-LOST-0001");
    expect(prefetch).toHaveBeenCalledWith("/mis-mascotas/DIM-OKAY-0003");
    expect(prefetch).toHaveBeenCalledTimes(2);
  });

  it("prefetches only the one existing neighbor at an end", () => {
    renderCarousel("DIM-LOST-0001");
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("/mis-mascotas/DIM-PREG-0002");
  });
});
