// @vitest-environment jsdom
//
// NIGHT-3 item #2 (drawer aggregate header) — a dual-mode point layer
// (perdidas/mordeduras) clicked as an AGGREGATED bubble carries no per-entity
// identity, so the drawer must render a UNIT SUMMARY (place + kind + value with
// unit + period) instead of the four dead "—" rows of the per-pet header. The
// real per-pet header is preserved for points-mode dots.
//
// FeatureBody is tested in isolation (not the full DetailDrawer) to avoid the
// native <dialog>.showModal() jsdom gap and the unit-history fetch.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FeatureBody, byTypeLabel } from "@/components/panorama/DetailDrawer";

vi.mock("next/navigation", () => ({
  usePathname: () => "/gob/panorama",
}));

afterEach(cleanup);

describe("DetailDrawer FeatureBody — dual-mode aggregate header (item #2)", () => {
  it("renders a unit summary for an AGGREGATED perdidas cell, not dead per-pet rows", () => {
    render(
      <FeatureBody
        layerId="perdidas"
        properties={{
          place: "La Plata, Buenos Aires",
          province: "Buenos Aires",
          locality: "La Plata",
          level: "locality",
          count: 12,
          suppressed: false,
        }}
        periodLabel="últimos 90 días"
      />,
    );

    expect(screen.getByText("La Plata, Buenos Aires")).toBeInTheDocument();
    expect(screen.getByText("Reportes de pérdida")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("últimos 90 días")).toBeInTheDocument();
    // The per-pet header must NOT appear for an aggregated cell.
    expect(screen.queryByText("Mascota")).not.toBeInTheDocument();
    expect(screen.queryByText("Visto por última vez")).not.toBeInTheDocument();
  });

  it("keeps the per-pet header for a POINTS-MODE perdidas dot", () => {
    render(
      <FeatureBody
        layerId="perdidas"
        properties={{
          token: "DIM-PAMP-0001",
          name: "Pampa",
          species: "dog",
          status: "lost",
          lastSeenAt: "2026-06-30T12:00:00Z",
          locationSource: "gps",
        }}
      />,
    );

    expect(screen.getByText("Mascota")).toBeInTheDocument();
    expect(screen.getByText("Pampa")).toBeInTheDocument();
    expect(screen.getByText("Visto por última vez")).toBeInTheDocument();
    // The aggregate value label must NOT appear for an individual dot.
    expect(screen.queryByText("Reportes de pérdida")).not.toBeInTheDocument();
  });

  it("honors k-anon on a suppressed aggregated perdidas cell (never a count)", () => {
    render(
      <FeatureBody
        layerId="perdidas"
        properties={{
          place: "Localidad X, Buenos Aires",
          province: "Buenos Aires",
          locality: "Localidad X",
          level: "locality",
          count: null,
          suppressed: true,
        }}
        periodLabel="últimos 90 días"
      />,
    );

    expect(screen.getByText(/Suprimido \(privacidad · k‑anon\)/)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders a unit summary for an AGGREGATED mordeduras cell", () => {
    render(
      <FeatureBody
        layerId="mordeduras"
        properties={{
          place: "Rosario, Santa Fe",
          province: "Santa Fe",
          locality: "Rosario",
          level: "locality",
          count: 7,
          suppressed: false,
        }}
        periodLabel="últimos 30 días"
      />,
    );

    expect(screen.getByText("Rosario, Santa Fe")).toBeInTheDocument();
    expect(screen.getByText("Mordeduras registradas")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.queryByText("Incidente")).not.toBeInTheDocument();
  });
});

describe("byTypeLabel — es-AR labels for the unit-history byType keys (T5.1)", () => {
  it("resolves welfare-report kinds through the domain catalog (no raw English)", () => {
    expect(byTypeLabel("abandonment")).toBe("Abandono");
    expect(byTypeLabel("neglect")).toBe("Negligencia (sin agua/comida/refugio)");
    expect(byTypeLabel("hoarding")).toBe("Acumulación de animales");
  });

  it("resolves pet-event types through the canonical event catalog", () => {
    expect(byTypeLabel("outbreak_signal")).toBe("Señal de brote");
    expect(byTypeLabel("vaccination_administered")).toBe("Vacuna administrada");
    expect(byTypeLabel("death_recorded")).toBe("Fallecimiento");
  });

  it("resolves the synthetic panorama keys (perdidas kinds, incidents, custody)", () => {
    expect(byTypeLabel("pet_lost")).toBe("Mascota perdida");
    expect(byTypeLabel("pet_found_sighting")).toBe("Avistaje");
    expect(byTypeLabel("bite_inflicted")).toBe("Mordedura infligida");
    expect(byTypeLabel("custody_episode")).toBe("Episodio de custodia");
  });

  it("falls back to the raw key ONLY for a kind no catalog knows", () => {
    expect(byTypeLabel("some_future_kind")).toBe("some_future_kind");
  });
});
