// @vitest-environment jsdom
//
// QueueFilterChips — the Denuncias·Triage work-queue selector after UI review
// M5 demoted it from a second row of TABS to filter chips. These tests pin the
// three things that made the demotion worth doing:
//
//   - the chips are LINKS carrying the ?queue= contract (so the URL still is
//     the state, and a full document navigation still is the commit path),
//   - selection is announced as `aria-current`, NOT role="tab"/aria-selected —
//     there is no tablist and no tabpanel left for those to be true about,
//   - a counter appears ONLY where the page already has the number; a chip
//     without one is the honest rendering, not a missing feature.

import "@testing-library/jest-dom/vitest";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { type QueueChipItem, QueueFilterChips } from "./QueueFilterChips";

const ITEMS: QueueChipItem[] = [
  { value: "urgent", label: "Urgentes", href: "/gob/denuncias?etapa=triage&queue=urgent" },
  {
    value: "unassigned",
    label: "Sin asignar",
    href: "/gob/denuncias?etapa=triage&queue=unassigned",
    count: 12,
  },
  { value: "mine", label: "Mías", href: "/gob/denuncias?etapa=triage&queue=mine", count: 0 },
  { value: "all", label: "Todas", href: "/gob/denuncias?etapa=triage&queue=all" },
];

function renderChips(activeValue = "unassigned") {
  return render(
    <QueueFilterChips items={ITEMS} activeValue={activeValue} ariaLabel="Cola de denuncias" />,
  );
}

describe("<QueueFilterChips>", () => {
  it("renders one link per queue, each carrying its own ?queue= address", () => {
    renderChips();
    const nav = screen.getByRole("navigation", { name: "Cola de denuncias" });
    const links = within(nav).getAllByRole("link");

    expect(links).toHaveLength(4);
    expect(links[0]).toHaveAttribute("href", "/gob/denuncias?etapa=triage&queue=urgent");
    expect(links[3]).toHaveAttribute("href", "/gob/denuncias?etapa=triage&queue=all");
  });

  it("marks exactly one chip as current, and never claims tab semantics", () => {
    renderChips("mine");

    expect(screen.getByRole("link", { name: /Mías/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Urgentes/ })).not.toHaveAttribute("aria-current");
    // The whole point of M5: this row is no longer a second tab system.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("shows a counter only for the queues the page already counts", () => {
    renderChips();

    expect(screen.getByRole("link", { name: /Sin asignar/ })).toHaveTextContent("12");
    // No count → no badge, rather than a zero that would read as "nothing here".
    expect(screen.getByRole("link", { name: /Urgentes/ })).toHaveTextContent(/^Urgentes$/);
    expect(screen.getByRole("link", { name: /Todas/ })).toHaveTextContent(/^Todas$/);
  });

  it("renders an explicit 0 for a counted-but-empty queue (0 is information)", () => {
    renderChips();
    expect(screen.getByRole("link", { name: /Mías/ })).toHaveTextContent("0");
  });

  // The counter used to carry an `aria-label` on the bare <span> holding the
  // digits. Name-from-author is only guaranteed on elements whose role
  // supports naming, and a role-less <span> is not one — the label can be
  // dropped, leaving AT with "Sin asignar 12". The number is therefore
  // aria-hidden decoration and an sr-only twin carries the phrase, so the
  // link's own ACCESSIBLE NAME is what gets asserted here.
  //
  // The `\s*` is a JSDOM artifact, not slack in the contract: accname joins two
  // INLINE children with no separator, and jsdom applies no stylesheet, so the
  // `.sr-only` span stays inline here. In a browser that class sets
  // `position:absolute`, which blockifies the box and gets the separating space
  // for free. What is being pinned is the phrase, not the whitespace.
  it("names what the counter counts instead of leaving a bare number", () => {
    renderChips();

    expect(screen.getByRole("link", { name: /^Sin asignar\s*12 denuncias$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Mías\s*0 denuncias$/ })).toBeInTheDocument();
  });

  it("does not depend on name-from-author on a role-less element", () => {
    const { container } = renderChips();
    // The visible digits are decoration; nothing in the row leans on an
    // aria-label to be announced.
    expect(container.querySelector("[aria-hidden='true']")?.textContent).toBe("12");
    expect(container.querySelector("span[aria-label]")).toBeNull();
  });

  it("pluralizes a single-item counter in es-AR ('1 denuncia', not '1 denuncias')", () => {
    render(
      <QueueFilterChips
        items={[{ value: "mine", label: "Mías", href: "/x?queue=mine", count: 1 }]}
        activeValue="mine"
        ariaLabel="Cola de denuncias"
      />,
    );
    expect(screen.getByRole("link", { name: /^Mías\s*1 denuncia$/ })).toBeInTheDocument();
  });
});
