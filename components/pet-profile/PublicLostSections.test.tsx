// @vitest-environment jsdom
//
// PublicLostSections is the lost DOCUMENT — facts on the paper, no finder
// verbs (those live in PublicCredentialActions). This file pins the facts
// that must stay on the card: Lo busca, last-seen place-first, identity line,
// caretaker as alternate (never as owner).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PublicLostSections } from "./PublicLostSections";

const BASE_PROPS = {
  petName: "Firulais",
  petSex: "male",
  identityLine: "Canino · marrón",
  ownerFirstName: null,
  ownerPhoneE164: null,
  ownerEmail: null,
  lastSeenPlaceName: null,
  lastSeenLocality: null,
  distinguishingFeatures: null,
  finderFormHref: null,
  sightingFormHref: null,
  lostSince: new Date("2026-06-01T12:00:00Z"),
};

afterEach(cleanup);

describe("PublicLostSections — document, not actions", () => {
  it("renders no relay links even when the page passed hrefs (verbs sit below the card)", () => {
    render(
      <PublicLostSections
        {...BASE_PROPS}
        sightingFormHref="/p/DIM-TEST-0001/sighting"
        finderFormHref="/p/DIM-TEST-0001/encontre"
        ownerPhoneE164="+5491155551234"
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(/tengo conmigo|vi cerca|llamar/i)).toBeNull();
  });

  it("disputed or empty: still no channels warning and no authority notice on the paper", () => {
    const { rerender } = render(<PublicLostSections {...BASE_PROPS} custodyDisputed />);
    expect(screen.queryByText(/canales de contacto/)).toBeNull();
    rerender(<PublicLostSections {...BASE_PROPS} />);
    expect(screen.queryByText(/canales de contacto/)).toBeNull();
  });
});

describe("PublicLostSections — owner name disclosure (M1)", () => {
  it("name disclosed, phone off: renders the standalone 'Lo busca' line", () => {
    render(<PublicLostSections {...BASE_PROPS} ownerFirstName="Graciela" />);

    expect(screen.getByText(/Lo busca Graciela/)).toBeInTheDocument();
  });

  it("name not disclosed: no 'Lo busca' line", () => {
    render(<PublicLostSections {...BASE_PROPS} />);

    expect(screen.queryByText(/Lo busca/)).toBeNull();
  });
});

describe("PublicLostSections — last-seen reads place-first (M3)", () => {
  const LOCATED = {
    ...BASE_PROPS,
    lastSeenPlaceName: null,
    lastSeenLocality: "Ushuaia",
    lastSeenLat: -54.80606,
    lastSeenLng: -68.304976,
    lastSeenCoords: "-54.806060, -68.304976",
    lastSeenAt: new Date("2026-05-14T12:00:00Z"),
    lostSince: new Date("2026-05-14T12:00:00Z"),
  };

  it("leads with the place and the recency, not the coordinate pair", () => {
    render(<PublicLostSections {...LOCATED} />);

    expect(screen.getByText(/^Ushuaia · hace \d+ (días|día|meses|mes)$/)).toBeInTheDocument();
  });

  it("does not publish coordinates, a map, or a Google Maps link", () => {
    const { container } = render(<PublicLostSections {...LOCATED} />);

    expect(container.querySelector('[data-section="lost-last-seen-coords"]')).toBeNull();
    expect(screen.queryByText(/Google Maps/)).toBeNull();
    expect(screen.queryByText(/-54\.806060/)).toBeNull();
  });

  it("hides the last-seen block when there is only a pin and no place text", () => {
    render(<PublicLostSections {...LOCATED} lastSeenLocality={null} />);

    expect(screen.queryByText(/Punto marcado en el mapa/)).toBeNull();
    expect(screen.queryByText(/^hace/)).toBeNull();
  });
});

describe("PublicLostSections — degenerate identity line", () => {
  it("renders nothing where the description would be when the caller has no traits to show", () => {
    const { container } = render(<PublicLostSections {...BASE_PROPS} identityLine="" />);

    expect(screen.queryByText("Perro")).toBeNull();
    expect(container.querySelectorAll("p:empty")).toHaveLength(0);
  });

  it("still renders a real description line", () => {
    render(<PublicLostSections {...BASE_PROPS} identityLine="Perro · marrón · collar rojo" />);

    expect(screen.getByText("Perro · marrón · collar rojo")).toBeInTheDocument();
  });
});

describe("PublicLostSections — caretaker as alternate contact", () => {
  it("says nothing about a caretaker by default", () => {
    const { container } = render(<PublicLostSections {...BASE_PROPS} />);

    expect(container.querySelector('[data-section="lost-caretaker-contact"]')).toBeNull();
    expect(container.querySelector('[data-section="lost-caretaker-call"]')).toBeNull();
  });

  it("says nothing when the caller passes null (both keys, or either, unmet)", () => {
    const { container } = render(
      <PublicLostSections {...BASE_PROPS} ownerFirstName="Ignacio" caretakerContact={null} />,
    );

    expect(container.querySelector('[data-section="lost-caretaker-contact"]')).toBeNull();
    expect(screen.getByText("Lo busca Ignacio.")).toBeInTheDocument();
  });

  it("names the caretaker as an ALTERNATE, never as the owner", () => {
    render(
      <PublicLostSections
        {...BASE_PROPS}
        ownerFirstName="Ignacio"
        caretakerContact={{ firstName: "Ana", phoneE164: "+541155550001" }}
      />,
    );

    expect(screen.getByText("Lo busca Ignacio.")).toBeInTheDocument();
    expect(screen.getByText("Mientras tanto la cuida Ana.")).toBeInTheDocument();
  });

  it("does not put the caretaker phone on the paper", () => {
    const { container } = render(
      <PublicLostSections
        {...BASE_PROPS}
        ownerPhoneE164="+541155550000"
        caretakerContact={{ firstName: "Ana", phoneE164: "+541155550001" }}
      />,
    );

    expect(container.querySelector('[data-section="lost-caretaker-call"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
