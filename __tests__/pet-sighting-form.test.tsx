// Structural smoke tests for <PetSightingForm>.
//
// Render via react-dom/server → HTML string (same pattern as Field.test.tsx /
// Checkbox.test.tsx). This avoids jsdom + @testing-library. Assertions focus
// on the presence of the two collapsible groups, the contact inputs, the photo
// input, and the a11y/contrast fixes introduced in P0d.
//
// `useActionState` is a client-side hook that is NOT supported in
// renderToStaticMarkup (React 19 server render). We replace the React module's
// `useActionState` with a vi.fn() stub that returns a static state tuple so
// the component renders predictably.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Controlled stub for useActionState — declared outside mocks so tests can
// call .mockReturnValue on it directly.
// ---------------------------------------------------------------------------
const mockUseActionState = vi.fn();

vi.mock("react", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof React;
  return {
    ...actual,
    useActionState: (...args: unknown[]) => mockUseActionState(...args),
  };
});

// Mock the server action import so the module resolves without real DB deps.
vi.mock("@/app/actions/pet-sighting", () => ({
  reportPetSightingAction: vi.fn(),
}));

// Mock next/link — server render requires an href-only anchor.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import { PetSightingForm } from "@/app/(public)/p/[publicToken]/sighting/PetSightingForm";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const BASE_PROPS = {
  publicToken: "DIM-TEST-001",
  petName: "Luna",
  biasProvince: "Buenos Aires",
  biasLocality: "La Plata",
};

const INITIAL_STATE = { ok: false as const, error: null };
const formActionStub = () => {};

describe("<PetSightingForm> — initial state (form render)", () => {
  beforeEach(() => {
    mockUseActionState.mockReturnValue([INITIAL_STATE, formActionStub, false]);
  });

  it("renders both collapsible groups", () => {
    const html = render(<PetSightingForm {...BASE_PROPS} />);
    expect(html).toContain("<details");
    expect(html).toContain("¿Le sacaste foto?");
    expect(html).toContain("¿Querés que te puedan contactar?");
  });

  it("renders the photo file input inside the photo group", () => {
    const html = render(<PetSightingForm {...BASE_PROPS} />);
    expect(html).toContain('type="file"');
    expect(html).toContain('name="photo"');
    expect(html).toContain('accept="image/*"');
  });

  it("renders finderName and finderContact inputs", () => {
    const html = render(<PetSightingForm {...BASE_PROPS} />);
    expect(html).toContain('name="finderName"');
    expect(html).toContain('name="finderContact"');
  });

  it("submit button uses text-white on azul (a11y contrast fix)", () => {
    const html = render(<PetSightingForm {...BASE_PROPS} />);
    const buttonMatch = html.match(/<button[^>]*type="submit"[^>]*class="([^"]+)"/);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch?.[1]).toContain("text-white");
    expect(buttonMatch?.[1]).not.toContain("text-black");
  });

  it("renders the description textarea and sightedAt input (back-compat: existing fields present)", () => {
    const html = render(<PetSightingForm {...BASE_PROPS} />);
    expect(html).toContain('name="description"');
    expect(html).toContain('name="sightedAt"');
  });

  // A3 (UI review 2026-08-06): "¿Cuándo la viste?" was a native
  // <input type="datetime-local">, whose visible text follows the BROWSER's
  // locale — month/day order and an AM/PM clock for anyone on an en-US machine,
  // on the field that decides when a lost pet was seen. It is now two
  // author-owned masked text fields (dd/mm/aaaa + HH:mm) recomposed into the
  // SAME hidden "sightedAt" the server action already parses.
  describe("¿Cuándo la viste? — es-AR date + time", () => {
    it("renders NO native datetime-local (nor a native time widget)", () => {
      const html = render(<PetSightingForm {...BASE_PROPS} />);
      expect(html).not.toContain('type="datetime-local"');
      expect(html).not.toContain('type="time"');
      expect(html).not.toContain('type="date"');
    });

    it("renders the two masked halves with es-AR placeholders and labels", () => {
      const html = render(<PetSightingForm {...BASE_PROPS} />);
      expect(html).toContain('id="sightedAtDate"');
      expect(html).toContain('id="sightedAtTime"');
      expect(html).toContain('placeholder="dd/mm/aaaa"');
      expect(html).toContain('placeholder="hh:mm"');
      expect(html).toContain("Hora (24 h)");
    });

    it("submits sightedAt as a hidden YYYY-MM-DDTHH:mm composed from both halves", () => {
      const html = render(<PetSightingForm {...BASE_PROPS} />);
      const hidden = html.match(/<input type="hidden" name="sightedAt" value="([^"]*)"/);
      expect(hidden).not.toBeNull();
      // Exactly the wire format parseArDatetimeLocal accepts — unchanged from
      // what the datetime-local used to submit.
      expect(hidden?.[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });
  });
});

describe("<PetSightingForm> — success state", () => {
  beforeEach(() => {
    mockUseActionState.mockReturnValue([{ ok: true as const, error: null }, formActionStub, false]);
  });

  it("renders the success message", () => {
    const html = render(<PetSightingForm {...BASE_PROPS} />);
    expect(html).toContain("¡Gracias!");
  });

  it("renders the exit link back to the pet profile", () => {
    const html = render(<PetSightingForm {...BASE_PROPS} />);
    expect(html).toContain("/p/DIM-TEST-001");
    expect(html).toContain("Luna");
  });

  it("shows a non-fatal photo warning when state.warning is set", () => {
    mockUseActionState.mockReturnValue([
      {
        ok: true as const,
        error: null,
        warning: "No se pudo subir la foto, pero el avistaje fue registrado igual.",
      },
      formActionStub,
      false,
    ]);
    const html = render(<PetSightingForm {...BASE_PROPS} />);
    expect(html).toContain("No se pudo subir la foto");
  });
});
