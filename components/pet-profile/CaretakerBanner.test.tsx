// @vitest-environment jsdom
//
// The titular's caretaker cockpit — one banner in the pet profile's alert strip.
//
// It absorbs task T7.6 ("el titular autenticado ve «Al cuidado de Ana hasta el
// 15/09»"), which turned out to be this same widget written twice under two
// numbers.
//
// THE ASSERTION THAT MATTERS MOST IN THIS FILE is the post-auto-end sentence.
// When a period lapses, the system knows one thing — access was withdrawn — and
// does NOT know whether the animal came home. Any copy that implies it did is a
// lie told to a worried owner by their own credential. The string is pinned
// verbatim, and then pinned again as a property, so a future rewrite cannot
// satisfy one and break the other.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CaretakerBanner } from "./CaretakerBanner";

const NOW = new Date("2026-09-20T12:00:00Z");
const PET = { name: "Pampa", publicToken: "DIM-TEST-0001" };

afterEach(() => cleanup());

describe("nothing to say", () => {
  it("renders nothing when the pet has no caretaker story at all", () => {
    const { container } = render(
      <CaretakerBanner
        petName={PET.name}
        petPublicToken={PET.publicToken}
        state={{ active: null, pending: null, recentlyEnded: null }}
        now={NOW}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("an ACTIVE arrangement", () => {
  const state = {
    active: {
      grantId: "g1",
      grantPublicToken: "CG-abc123",
      caretakerUserId: "u2",
      caretakerName: "Ana",
      startsAt: new Date("2026-08-20T03:00:00Z"),
      endsAt: new Date("2026-09-15T23:59:59.999-03:00"),
      publicContactConsentAt: null,
    },
    pending: null,
    recentlyEnded: null,
  };

  it("says who and until when", () => {
    render(
      <CaretakerBanner
        petName={PET.name}
        petPublicToken={PET.publicToken}
        state={state}
        now={NOW}
      />,
    );
    expect(screen.getByText("Al cuidado de Ana hasta el 15/09")).toBeInTheDocument();
  });

  it("leads to the surface where it can be ended", () => {
    render(
      <CaretakerBanner
        petName={PET.name}
        petPublicToken={PET.publicToken}
        state={state}
        now={NOW}
      />,
    );
    expect(screen.getByRole("link", { name: /cuidado/i })).toHaveAttribute(
      "href",
      "/mis-mascotas/DIM-TEST-0001/cuidado",
    );
  });
});

describe("a PENDING invitation", () => {
  const state = {
    active: null,
    pending: {
      grantId: "g1",
      grantPublicToken: "CG-abc123",
      caretakerEmail: "ana@example.com",
      caretakerUserId: null,
      startsAt: new Date("2026-09-01T03:00:00Z"),
      endsAt: new Date("2026-09-15T23:59:59.999-03:00"),
    },
    recentlyEnded: null,
  };

  it("names who was invited and says nobody has access yet", () => {
    render(
      <CaretakerBanner
        petName={PET.name}
        petPublicToken={PET.publicToken}
        state={state}
        now={NOW}
      />,
    );
    expect(screen.getByText(/ana@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/todav.a nadie tiene acceso/i)).toBeInTheDocument();
  });
});

describe("after the arrangement AUTO-ENDED — access expired, possession unknown", () => {
  const state = {
    active: null,
    pending: null,
    recentlyEnded: {
      caretakerName: "Ana",
      endsAt: new Date("2026-09-15T23:59:59.999-03:00"),
      endedAt: new Date("2026-09-16T07:00:00Z"),
      outcome: "expired" as const,
    },
  };

  function renderIt() {
    return render(
      <CaretakerBanner
        petName={PET.name}
        petPublicToken={PET.publicToken}
        state={state}
        now={NOW}
      />,
    );
  }

  it("reads exactly as the spec wrote it", () => {
    renderIt();
    expect(
      screen.getByText(
        "El cuidado temporal de Ana terminó el 15/09. Si Pampa sigue con Ana, coordiná la devolución o iniciá un reclamo.",
      ),
    ).toBeInTheDocument();
  });

  it("never claims the animal is back", () => {
    renderIt();
    const text = document.body.textContent ?? "";
    for (const claim of ["volvió", "de vuelta", "regresó", "recuperaste", "ya está con vos"]) {
      expect(text.toLowerCase()).not.toContain(claim);
    }
  });

  it("offers the titular the next move instead of only reporting the fact", () => {
    renderIt();
    const text = document.body.textContent ?? "";
    expect(text).toContain("coordiná la devolución");
    expect(text).toContain("iniciá un reclamo");
  });
});
