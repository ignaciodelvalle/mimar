// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ResultCount } from "./ResultCount";

// The reason this primitive exists is the EPISTEMIC split, so that is what the
// tests lock: a screen that merely capped its query must never render a claim
// that implies somebody counted the rest.
describe("ResultCount", () => {
  afterEach(cleanup);

  it("states an exact, checkable count when the total is known", () => {
    render(<ResultCount shown={12} total={1263} noun="casos" />);
    expect(screen.getByText(/Mostrando 12 de 1\.263 casos\./)).toBeTruthy();
  });

  it("never invents a total when the list was merely capped", () => {
    const { container } = render(<ResultCount shown={200} noun="transferencias" />);
    expect(container.textContent).toContain("Mostrando los primeros 200 transferencias — hay más");
    // "de 200" would claim the cap IS the universe.
    expect(container.textContent).not.toMatch(/de 200/);
  });

  it("offers the escape hatch only when there is more to reach", () => {
    const { container: capped } = render(
      <ResultCount shown={200} noun="casos" hint="Usá los filtros para acotar." />,
    );
    expect(capped.textContent).toContain("Usá los filtros para acotar.");
    cleanup();
    // Everything already on screen — a "narrow your search" nudge would be noise.
    const { container: complete } = render(
      <ResultCount shown={7} total={7} noun="casos" hint="Usá los filtros para acotar." />,
    );
    expect(complete.textContent).not.toContain("Usá los filtros");
  });

  it("carries ordering context when the caller has one", () => {
    const { container } = render(
      <ResultCount shown={50} noun="usuarios" ordering="ordenados por rol y nombre" />,
    );
    expect(container.textContent).toContain("ordenados por rol y nombre");
  });

  it("agrees with itself in the singular", () => {
    const { container } = render(<ResultCount shown={1} noun="servicio" />);
    // The ordinal already carries the count — "el primer 1 servicio" is broken.
    expect(container.textContent).toContain("el primer servicio");
    expect(container.textContent).not.toContain("primer 1");
  });
});
