// @vitest-environment jsdom
//
// C4 (epistemic states) — the ranking's EMPTY state on the flagship
// epidemiological surface.
//
// Zero ranked rows means two OPPOSITE things, and the old copy collapsed both
// into "Sin jurisdicciones bajo meta en este alcance" — an all-clear printed
// while the system had measured nothing. "Sin señales ≠ sin enfermedad" is the
// whole point of the nature axis, and this is the surface where getting it
// wrong tells a ministry the country is fine.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PanoramaDataTable } from "@/components/panorama/PanoramaDataTable";

afterEach(cleanup);

describe("PanoramaDataTable — empty state tells the epistemic truth", () => {
  it("claims the all-clear ONLY when units were actually measured", () => {
    render(
      <PanoramaDataTable
        rows={[]}
        kind="rate"
        measureLabel="cobertura antirrábica"
        measuredUnits={24}
      />,
    );
    expect(screen.getByText(/Ninguna jurisdicción quedó bajo meta/)).toBeTruthy();
    // The claim must carry its own evidence — how many were measured.
    expect(screen.getByText(/Se midieron 24/)).toBeTruthy();
  });

  it("says it is BLIND when nothing could be measured", () => {
    render(
      <PanoramaDataTable
        rows={[]}
        kind="rate"
        measureLabel="cobertura antirrábica"
        measuredUnits={0}
      />,
    );
    // The exact regression: this must NOT read as good news.
    expect(screen.queryByText(/Ninguna jurisdicción quedó bajo meta/)).toBeNull();
    expect(screen.getByText(/Sin señales en este alcance/)).toBeTruthy();
    expect(screen.getByText(/Sin señales no es lo mismo que sin problema/)).toBeTruthy();
  });

  it("treats a failed calculation as blindness, not as a result", () => {
    render(
      <PanoramaDataTable
        rows={[]}
        kind="rate"
        measureLabel="cobertura antirrábica"
        measuredUnits={24}
        dataUnavailable
      />,
    );
    expect(screen.getByText(/No pudimos calcular el ranking/)).toBeTruthy();
    expect(screen.getByText(/No es un resultado/)).toBeTruthy();
  });

  it("never claims an all-clear for a density metric — it has no target", () => {
    render(
      <PanoramaDataTable rows={[]} kind="density" measureLabel="mordeduras" measuredUnits={24} />,
    );
    expect(screen.getByText(/Sin señales en este alcance/)).toBeTruthy();
  });

  it("distinguishes WITHHELD from blind — units reported, privacy forbids showing", () => {
    // The lie this closes, found live on Mortalidad 2026-07-25: the dock showed
    // 154 records beside an empty ranking saying "nobody reported enough to
    // measure". Every per-unit value (2-6) sat under k=5, so the system was not
    // blind at all — it was protecting.
    render(
      <PanoramaDataTable
        rows={[]}
        kind="density"
        measureLabel="mortalidad registrada"
        measuredUnits={0}
        suppressedUnits={18}
      />,
    );
    expect(screen.getByText(/Protegido por k-anonimato/)).toBeTruthy();
    expect(screen.getByText(/18 .*S[ÍI] reportaron/)).toBeTruthy();
    // The false claim must be gone.
    expect(screen.queryByText(/Ninguna unidad del alcance reportó/)).toBeNull();
  });

  it("still says BLIND when nothing reported and nothing was withheld", () => {
    render(
      <PanoramaDataTable
        rows={[]}
        kind="density"
        measureLabel="mortalidad registrada"
        measuredUnits={0}
        suppressedUnits={0}
      />,
    );
    expect(screen.getByText(/Sin señales en este alcance/)).toBeTruthy();
  });

  it("a failed calculation outranks suppression — we know nothing either way", () => {
    render(
      <PanoramaDataTable
        rows={[]}
        kind="density"
        measureLabel="mortalidad registrada"
        suppressedUnits={18}
        dataUnavailable
      />,
    );
    expect(screen.getByText(/No pudimos calcular el ranking/)).toBeTruthy();
    expect(screen.queryByText(/Protegido por k-anonimato/)).toBeNull();
  });

  it("defaults to blindness when the caller passes no measured count", () => {
    // A caller that has not been taught to report its measurable universe must
    // not get the all-clear for free.
    render(<PanoramaDataTable rows={[]} kind="rate" measureLabel="cobertura antirrábica" />);
    expect(screen.getByText(/Sin señales en este alcance/)).toBeTruthy();
  });
});

describe("PanoramaDataTable — a censored tie is not an ordering", () => {
  const tied = [90, 90, 90, 90].map((v, i) => ({
    key: `p${i}`,
    label: `Provincia ${i}`,
    value: v,
    gap: null,
  }));

  it("says the units are tied at the measurement bound", () => {
    // desierto-veterinario, live 2026-07-25: 23 of 24 provinces sat exactly at
    // the 90-day cap, and the table presented an arbitrary slice of that tie as
    // "Peores 10". The cap is where measurement STOPS, not a worst value.
    render(
      <PanoramaDataTable
        rows={tied}
        kind="density"
        measureLabel="días sin actividad veterinaria"
        censoredAtMax={90}
      />,
    );
    expect(screen.getByText(/igualadas en el tope de medición/)).toBeTruthy();
    // Must not name a count: `rows` is the worst-N slice, not the tie's size.
    expect(screen.queryByText(/Las 4 unidades/)).toBeNull();
    expect(screen.getByText(/el valor es un piso, no una diferencia/)).toBeTruthy();
  });

  it("stays quiet when the rows genuinely differ", () => {
    render(
      <PanoramaDataTable
        rows={[...tied.slice(0, 3), { key: "x", label: "Otra", value: 12, gap: null }]}
        kind="density"
        measureLabel="días sin actividad veterinaria"
        censoredAtMax={90}
      />,
    );
    expect(screen.queryByText(/igualadas en el tope/)).toBeNull();
  });

  it("stays quiet for a layer that declares no bound", () => {
    render(<PanoramaDataTable rows={tied} kind="density" measureLabel="denuncias" />);
    expect(screen.queryByText(/igualadas en el tope/)).toBeNull();
  });
});
