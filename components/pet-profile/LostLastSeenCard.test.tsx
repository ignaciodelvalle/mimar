// Tests for LostLastSeenCard.
//
// Renders via react-dom/server → HTML string (same pattern as Field.test.tsx).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LostLastSeenCard } from "./LostLastSeenCard";

const baseProps = {
  placeName: "Plaza Italia",
  localityLabel: "La Plata",
  at: new Date("2024-06-01T10:00:00Z"),
  note: null,
  editHref: "/mis-mascotas/abc123/perdida",
};

describe("<LostLastSeenCard>", () => {
  it("renders the place name and locality", () => {
    const html = renderToStaticMarkup(<LostLastSeenCard {...baseProps} />);
    expect(html).toContain("Plaza Italia");
    expect(html).toContain("La Plata");
  });

  it("does NOT render the dead add-sighting link", () => {
    const html = renderToStaticMarkup(<LostLastSeenCard {...baseProps} />);
    expect(html).not.toContain("Agregar avistamiento");
    expect(html).not.toContain("avistamiento/nuevo");
  });

  it("does NOT render the retired share-helper copy or copy-link button (QA 2026-08-03)", () => {
    const html = renderToStaticMarkup(<LostLastSeenCard {...baseProps} />);
    expect(html).not.toContain("link de la credencial");
    expect(html).not.toContain("Copiar link público");
  });

  it("renders the optional owner note", () => {
    const html = renderToStaticMarkup(
      <LostLastSeenCard
        {...baseProps}
        note="Salió por la puerta del frente, llevaba collar rojo"
      />,
    );
    expect(html).toContain("collar rojo");
  });

  it("renders a single edit link to the provided editHref", () => {
    const html = renderToStaticMarkup(<LostLastSeenCard {...baseProps} />);
    expect(html).toContain("/mis-mascotas/abc123/perdida");
    expect(html).toContain("Editar");
  });

  it("still renders place name and edit link when coords are provided", () => {
    const html = renderToStaticMarkup(
      <LostLastSeenCard {...baseProps} lastSeenLat="-34.603722" lastSeenLng="-58.381592" />,
    );
    expect(html).toContain("Plaza Italia");
    expect(html).toContain("Editar");
  });

  it("shows the empty state with an add-location link when nothing was reported", () => {
    const html = renderToStaticMarkup(
      <LostLastSeenCard {...baseProps} placeName={null} lastSeenLat={null} lastSeenLng={null} />,
    );
    expect(html).toContain("Todavía no cargaste dónde se perdió.");
    expect(html).toContain("Agregar ubicación");
  });

  it("falls back to a generic caption when only coords exist (pin without address)", () => {
    const html = renderToStaticMarkup(
      <LostLastSeenCard
        {...baseProps}
        placeName={null}
        lastSeenLat="-34.603722"
        lastSeenLng="-58.381592"
      />,
    );
    expect(html).toContain("Punto marcado en el mapa");
    expect(html).not.toContain("Todavía no cargaste");
  });
});
