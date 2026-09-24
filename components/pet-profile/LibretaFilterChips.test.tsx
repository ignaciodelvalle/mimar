// @vitest-environment jsdom
//
// LibretaFilterChips — per-event-type narrowing of the ONE consolidated
// libreta timeline (B3 redefined, 2026-07-31).
//
// WHAT IS UNDER TEST AND WHY
// ---------------------------
// ADR-10's single-timeline collapse stands; what it left unsolved is the
// owner's most common question — "¿cuándo fue la última X?" — against up to
// PAST_EVENTS_WINDOW mixed asientos (critique-libreta 2026-07-27 #3/#8).
// LIBRETA_FILTER_CHIPS described the vocabulary but had no consumer.
//
// These tests pin the four judgment calls, not just the wiring:
//   1. only types WITH at least one loaded row get a chip (a chip that
//      filters to nothing is a dead control),
//   2. the count rides ON the chip (half the answer, before any tap),
//   3. selecting narrows the feed AND the "Asientos · N registros" label,
//      "Todos" restores it,
//   4. fewer than two matching types renders no bar at all.
// Plus the invariant that makes the "no empty state" decision safe: the chips
// are derived from the SAME array they filter, after the audience lens, so a
// selection can never resolve to zero rows.
//
// Rendered through the real <LibretaFace> tree (not the chip bar in
// isolation) because the filtering lives in the face's state — testing the
// presentational component alone would prove nothing about the feed.

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EventTimeline } from "@/app/(app)/mis-mascotas/[publicToken]/EventTimeline";
import { libretaChipCounts } from "@/lib/infra/libreta-sanitaria";
import type {
  HistorialEventRow,
  LibretaFaceData,
} from "@/src/modules/pets/application/tab-data/types";
import { LibretaFace } from "./LibretaFace";

const CHIP_GROUP_LABEL = "Filtrar asientos por tipo";
const OWNER_USER = "user-owner";

function row(id: string, eventType: string, payload: unknown = {}): HistorialEventRow {
  return {
    id,
    petId: "pet-1",
    eventType,
    payload,
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    notes: null,
    recordedByUserId: OWNER_USER,
    authorRole: "owner",
    authorVerified: false,
    authorOrganizationId: null,
    attachmentUrl: null,
    hasAttachment: false,
    amendedAt: null,
  };
}

// 3 vacunas + 2 pesos + 1 visita + 1 nota = 7 asientos for an owner.
// `note_added` is deliberately included: it is a NON_LIBRETA type with no chip
// in LIBRETA_FILTER_CHIPS, so it proves that an uncovered type stays visible
// under "Todos" while never earning a chip of its own — and that the org lens
// drops it before the counts are taken.
const MIXED_PAST: HistorialEventRow[] = [
  row("v1", "vaccination_administered", { vaccine_name: "Antirrábica" }),
  row("v2", "vaccination_administered", { vaccine_name: "Quíntuple" }),
  row("v3", "vaccination_administered", { vaccine_name: "Antirrábica" }),
  row("w1", "weight_recorded", { weight_kg: 12 }),
  row("w2", "weight_recorded", { weight_kg: 13 }),
  row("c1", "vet_visit_logged", { reason: "Control anual" }),
  row("n1", "note_added", { category: "recordatorio" }),
];

function faceData(overrides: Partial<LibretaFaceData> = {}): LibretaFaceData {
  return {
    identity: {
      name: "Firulais",
      species: "dog",
      breed: "Mestizo",
      sex: "male",
      microchipId: null,
      tattooCode: null,
      tattooLocation: null,
      publicToken: "abc",
    },
    future: [],
    past: MIXED_PAST,
    pastTruncated: false,
    summary: {
      active: 0,
      dueSoon: 0,
      expired: 0,
      missing: 0,
      unconfirmed: 0,
      otherCount: 0,
      perVaccine: [],
    },
    weightSamples: [],
    activeShares: [],
    accessPath: "owner",
    viewer: { userId: OWNER_USER, currentOwnerUserId: OWNER_USER },
    ...overrides,
  };
}

function renderFace(data: LibretaFaceData = faceData(), isOwner = true) {
  return render(<LibretaFace data={data} petPublicToken="abc" isOwner={isOwner} />);
}

/** Chip bar buttons, in DOM order, as "label count" strings. */
function chipLabels(): string[] {
  const group = screen.getByRole("group", { name: CHIP_GROUP_LABEL });
  return within(group)
    .getAllByRole("button")
    .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
}

function asientoCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-section="asiento"]').length;
}

function pressChip(name: string) {
  const group = screen.getByRole("group", { name: CHIP_GROUP_LABEL });
  fireEvent.click(within(group).getByRole("button", { name }));
}

describe("libretaChipCounts — the derivation behind the bar", () => {
  it("keeps LIBRETA_FILTER_CHIPS order and drops types with no rows", () => {
    // Declared order is vacunas, antiparasitarios, esterilización, visitas,
    // peso, … — the result must follow it, not the row order.
    expect(libretaChipCounts(MIXED_PAST)).toEqual([
      { type: "vaccination_administered", label: "Vacunas", count: 3 },
      { type: "vet_visit_logged", label: "Visitas", count: 1 },
      { type: "weight_recorded", label: "Peso", count: 2 },
    ]);
  });

  it("returns nothing for an empty feed", () => {
    expect(libretaChipCounts([])).toEqual([]);
  });
});

describe("<LibretaFace> filter chips — what renders", () => {
  it("renders one chip per present type, in declared order, with its count", () => {
    renderFace();
    expect(chipLabels()).toEqual(["Todos 7", "Vacunas 3", "Visitas 1", "Peso 2"]);
  });

  it("renders no chip for a libreta type with zero events", () => {
    renderFace();
    const group = screen.getByRole("group", { name: CHIP_GROUP_LABEL });
    // Antiparasitarios / Esterilización / Microchip are all in
    // LIBRETA_FILTER_CHIPS but absent from this pet's history.
    expect(within(group).queryByRole("button", { name: /Antiparasitarios/ })).toBeNull();
    expect(within(group).queryByRole("button", { name: /Esterilización/ })).toBeNull();
    expect(within(group).queryByRole("button", { name: /Microchip/ })).toBeNull();
  });

  it("renders no bar at all when fewer than two types are present", () => {
    // One type = "Todos 1 / Vacunas 1", a control that cannot change anything.
    renderFace(faceData({ past: [row("v1", "vaccination_administered", {})] }));
    expect(screen.queryByRole("group", { name: CHIP_GROUP_LABEL })).toBeNull();
  });

  it("counts only what the audience lens left, for an org viewer", () => {
    // note_added is NON_LIBRETA: the org lens removes it upstream, so it must
    // not be counted in "Todos". This is what makes an empty match impossible
    // — chips are derived AFTER the lens, from the array actually rendered.
    renderFace(faceData({ accessPath: "org" }), false);
    expect(chipLabels()).toEqual(["Todos 6", "Vacunas 3", "Visitas 1", "Peso 2"]);
  });
});

describe("<LibretaFace> filter chips — what they do", () => {
  it("narrows the feed and the asientos label, then restores it with Todos", () => {
    const { container } = renderFace();
    expect(asientoCount(container)).toBe(7);
    expect(screen.getByText("Asientos · 7 registros")).toBeInTheDocument();

    pressChip("Vacunas 3");
    expect(asientoCount(container)).toBe(3);
    expect(screen.getByText("Asientos · 3 registros")).toBeInTheDocument();
    expect(screen.queryByText("Control anual")).toBeNull();

    pressChip("Todos 7");
    expect(asientoCount(container)).toBe(7);
    expect(screen.getByText("Asientos · 7 registros")).toBeInTheDocument();
    expect(screen.getByText("Control anual")).toBeInTheDocument();
  });

  it("unions multiple selections and marks them pressed", () => {
    const { container } = renderFace();
    pressChip("Vacunas 3");
    pressChip("Peso 2");
    expect(asientoCount(container)).toBe(5);
    expect(screen.getByText("Asientos · 5 registros")).toBeInTheDocument();

    const group = screen.getByRole("group", { name: CHIP_GROUP_LABEL });
    expect(within(group).getByRole("button", { name: "Vacunas 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(group).getByRole("button", { name: "Todos 7" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("deselecting the last chip returns to the full feed", () => {
    const { container } = renderFace();
    pressChip("Vacunas 3");
    expect(asientoCount(container)).toBe(3);
    pressChip("Vacunas 3");
    expect(asientoCount(container)).toBe(7);
    const group = screen.getByRole("group", { name: CHIP_GROUP_LABEL });
    expect(within(group).getByRole("button", { name: "Todos 7" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps every chip selectable — no selection can empty the feed", () => {
    // The structural guarantee that replaces a "no matches" empty state.
    const { container } = renderFace();
    for (const label of ["Vacunas 3", "Visitas 1", "Peso 2"]) {
      pressChip(label);
      expect(asientoCount(container)).toBeGreaterThan(0);
      pressChip(label);
    }
  });
});

// The /historial chip bar predates this one and now shares the SAME
// derivation (libretaChipCounts) instead of its own inline counting loop.
// Pinned here so the dedup can't silently change that older bar's behavior.
describe("<EventTimeline> — the same derivation drives the historial chip bar", () => {
  it("shows only present types with their counts, and filters on click", () => {
    const events = MIXED_PAST.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      notes: null,
      attachmentUrl: null,
    }));
    render(<EventTimeline events={events} publicToken="abc" />);

    // DEFAULT_FILTER_CHIPS order puts Notas second; Antiparasitarios has no
    // event here and must not render.
    expect(screen.getByRole("button", { name: "Todos 7" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Vacunas 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notas 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Antiparasitarios/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Peso 2" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
