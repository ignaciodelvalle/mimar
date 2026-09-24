// Structural smoke tests for <FinderInPossessionForm> (P0e).
//
// Render via react-dom/server → HTML string (same pattern as PetSightingForm).
// useActionState and useState are stubbed so the component renders predictably
// without jsdom.
//
// Assertions focus on:
//   - Required fields: finderName, finderPhone, finderEmail, petCondition
//   - LocationFields is rendered (l2 mode — exact-point map picker)
//   - canKeepIndefinite checkbox + canKeepUntil datetime-local
//   - Photo file input in the collapsible group
//   - Success state: thank-you message + back link
//   - Logged-in banner renders when loggedIn=true (advisory only)
//   - Form values are NEVER prefilled from the session (PO 2026-07-16)

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Stub useActionState and useState before importing the component.
// ---------------------------------------------------------------------------

const mockUseActionState = vi.fn();
// useState stub: returns [initialValue, setter] for all calls.
// We need canKeepIndefinite to default to false so the datetime input renders.
const mockUseState = vi.fn((initialValue: unknown) => [initialValue, vi.fn()]);

vi.mock("react", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof React;
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useActionState: (...args: any[]) => mockUseActionState(...args),
    useState: (initialValue: unknown) => mockUseState(initialValue),
  };
});

vi.mock("@/app/(public)/p/[publicToken]/encontre/action", () => ({
  reportFinderInPossessionAction: vi.fn(),
}));

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

// LocationFields relies on hooks and dynamic imports; stub it for SSR render.
vi.mock("@/components/LocationFields", () => ({
  LocationFields: ({
    mode,
  }: {
    mode: string;
  }) => React.createElement("div", { "data-testid": "location-fields", "data-mode": mode }),
}));

import { FinderInPossessionForm } from "@/app/(public)/p/[publicToken]/encontre/FinderInPossessionForm";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const BASE_PROPS = {
  publicToken: "DIM-P0E-001",
  petName: "Luna",
  biasProvince: "Buenos Aires",
  biasLocality: "La Plata",
};

const INITIAL_STATE = { ok: false as const, error: null };
const formActionStub = () => {};

describe("<FinderInPossessionForm> — initial state (form render)", () => {
  beforeEach(() => {
    mockUseActionState.mockReturnValue([INITIAL_STATE, formActionStub, false]);
    mockUseState.mockImplementation((initialValue: unknown) => [initialValue, vi.fn()]);
  });

  it("renders finderName, finderPhone, finderEmail inputs", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain('name="finderName"');
    expect(html).toContain('name="finderPhone"');
    expect(html).toContain('name="finderEmail"');
  });

  it("renders all four petCondition radio options", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain('value="bien"');
    expect(html).toContain('value="herida"');
    expect(html).toContain('value="asustada"');
    expect(html).toContain('value="necesita_vet_urgente"');
  });

  it("renders the location fields (L2 mode — exact point)", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain("location-fields");
    expect(html).toContain('data-mode="l2"');
  });

  it("renders the canKeepIndefinite checkbox", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain("canKeepIndefiniteToggle");
    expect(html).toContain("indefinidamente");
  });

  // A3 datetime wave (2026-08-06): the native `<input type="datetime-local">`
  // was replaced by DateInputAr + TimeInputAr, because a datetime-local renders
  // its visible text in the BROWSER's locale (month/day order and an AM/PM
  // clock on an en-US machine) inside es-AR copy. What the ACTION receives is
  // unchanged: one `canKeepUntil` field carrying "YYYY-MM-DDTHH:mm".
  it("renders the two author-owned date/time halves when canKeepIndefinite is false (default)", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain('name="canKeepUntilDate"');
    expect(html).toContain('name="canKeepUntilTime"');
    expect(html).toContain("dd/mm/aaaa");
    expect(html).toContain("hh:mm");
    // No browser-locale-dependent control survives on this field.
    expect(html).not.toContain('type="datetime-local"');
  });

  it("still submits the composed canKeepUntil field the action parses", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain('name="canKeepUntil"');
    // Empty until BOTH halves hold a valid value — an emptied datetime-local
    // submitted nothing, and so does an incomplete pair (the action's
    // "indicá hasta cuándo…" guard is what rejects it).
    expect(html).toMatch(/<input type="hidden" name="canKeepUntil" value=""\s*\/>/);
  });

  it("renders the photo file input inside collapsible group", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain('name="photoNow"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="image/*"');
  });

  it("renders the optional message textarea", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain('name="message"');
  });

  it("renders the submit button with text-white on azul (a11y contrast)", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    const buttonMatch = html.match(/<button[^>]*type="submit"[^>]*class="([^"]+)"/);
    expect(buttonMatch).not.toBeNull();
    expect(buttonMatch?.[1]).toContain("text-white");
  });

  it("does NOT render the logged-in banner when loggedIn=false (default)", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).not.toContain("Tenés una sesión iniciada");
  });
});

describe("<FinderInPossessionForm> — logged-in advisory (no prefill, PO 2026-07-16)", () => {
  beforeEach(() => {
    mockUseActionState.mockReturnValue([INITIAL_STATE, formActionStub, false]);
    mockUseState.mockImplementation((initialValue: unknown) => [initialValue, vi.fn()]);
  });

  it("renders the logged-in banner when loggedIn=true and sessionDisplayName set", () => {
    const html = render(
      <FinderInPossessionForm {...BASE_PROPS} loggedIn sessionDisplayName="María García" />,
    );
    expect(html).toContain("Tenés una sesión iniciada");
    // Anonymity copy: the banner must state the report is NOT account-linked.
    expect(html).toContain("no queda vinculado a tu cuenta");
    expect(html).toContain("María García");
    // Sign-out escape hatch stays.
    expect(html).toContain("Salí de la sesión");
  });

  it("renders the banner without a name when the session has no display name", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} loggedIn />);
    expect(html).toContain("Tenés una sesión iniciada");
    expect(html).toContain("Salí de la sesión");
  });

  it("never prefills form values from the session", () => {
    const html = render(
      <FinderInPossessionForm {...BASE_PROPS} loggedIn sessionDisplayName="Pedro Sosa" />,
    );
    // Controlled inputs render with empty values — the session name must not
    // appear as a field value anywhere.
    expect(html).not.toContain('value="Pedro Sosa"');
    const nameInput = html.match(/<input[^>]*id="finderName"[^>]*>/)?.[0] ?? "";
    expect(nameInput).toContain('value=""');
    const phoneInput = html.match(/<input[^>]*id="finderPhone"[^>]*>/)?.[0] ?? "";
    expect(phoneInput).toContain('value=""');
    const emailInput = html.match(/<input[^>]*id="finderEmail"[^>]*>/)?.[0] ?? "";
    expect(emailInput).toContain('value=""');
  });
});

describe("<FinderInPossessionForm> — success state", () => {
  beforeEach(() => {
    mockUseActionState.mockReturnValue([{ ok: true as const, error: null }, formActionStub, false]);
    mockUseState.mockImplementation((initialValue: unknown) => [initialValue, vi.fn()]);
  });

  it("renders the success thank-you message", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain("¡Gracias!");
    expect(html).toContain("Le avisamos al dueño/a");
  });

  it("renders the back link to the pet profile", () => {
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain("/p/DIM-P0E-001");
    expect(html).toContain("Luna");
  });

  it("shows non-fatal photo warning when state.warning is set", () => {
    mockUseActionState.mockReturnValue([
      {
        ok: true as const,
        error: null,
        warning: "No se pudo subir la foto, pero el aviso fue registrado igual.",
      },
      formActionStub,
      false,
    ]);
    const html = render(<FinderInPossessionForm {...BASE_PROPS} />);
    expect(html).toContain("No se pudo subir la foto");
  });
});
