// Structural / a11y tests for <OpOmnibox> (Wave 2 Item 10.1).
//
// Render via react-dom/server → HTML string (repo pattern, no jsdom). React
// hooks are stubbed so we can drive the rendered state across the empty,
// no-results and grouped-results cases. Effects (debounce, shortcut listener)
// do not run under SSR — they are exercised indirectly by the action +
// search-lib integration tests.
//
// Asserted a11y contract (WAI-ARIA combobox pattern):
//   - role="combobox" + aria-expanded + aria-controls + aria-autocomplete
//   - placeholder copy + the "/" shortcut hint when empty
//   - dropdown role="listbox" with role="option" rows when results exist
//   - "Sin coincidencias en tu jurisdicción" on the no-results state

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OmniboxResults } from "@/lib/infra/omnibox-search";

// Hook stubs. useState is call-order driven via a queue so each test can inject
// a precise state vector. The order of useState calls in OpOmnibox is:
//   [query, results, open, loading, activeIndex, searched, mobileOpen]
let stateQueue: unknown[] = [];
let stateCursor = 0;

const mockUseState = vi.fn(() => {
  const value = stateQueue[stateCursor];
  stateCursor += 1;
  return [value, vi.fn()];
});

vi.mock("react", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof React;
  return {
    ...actual,
    useState: () => mockUseState(),
    useRef: () => ({ current: null }),
    useEffect: () => {},
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useId: () => "id-test",
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/app/actions/omnibox-search", () => ({
  searchOmniboxAction: vi.fn(),
  searchOmniboxOrgAction: vi.fn(),
}));

import { OpOmnibox } from "@/components/ui/dashboard/OpOmnibox";

const EMPTY: OmniboxResults = { pets: [], persons: [], cases: [], total: 0 };

function renderWithState(state: {
  query: string;
  results: OmniboxResults;
  open: boolean;
  loading: boolean;
  activeIndex: number;
  searched: boolean;
  /** Mobile-expanded search row (<md). Defaults collapsed — the desktop states above are what these tests pin. */
  mobileOpen?: boolean;
}): string {
  stateQueue = [
    state.query,
    state.results,
    state.open,
    state.loading,
    state.activeIndex,
    state.searched,
    state.mobileOpen ?? false,
  ];
  stateCursor = 0;
  return renderToStaticMarkup(<OpOmnibox />);
}

describe("<OpOmnibox> — empty state", () => {
  it("renders a combobox input with the search affordances", () => {
    const html = renderWithState({
      query: "",
      results: EMPTY,
      open: false,
      loading: false,
      activeIndex: -1,
      searched: false,
    });
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('aria-label="Búsqueda global"');
    expect(html).toContain("Mascota, nombre, DNI o caso…");
  });

  it("shows the / keyboard shortcut hint when empty", () => {
    const html = renderWithState({
      query: "",
      results: EMPTY,
      open: false,
      loading: false,
      activeIndex: -1,
      searched: false,
    });
    // The shortcut hint is an aria-hidden span containing "/".
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(">/<");
  });

  it("does not render the dropdown when the query is too short", () => {
    const html = renderWithState({
      query: "a",
      results: EMPTY,
      open: true,
      loading: false,
      activeIndex: -1,
      searched: false,
    });
    expect(html).not.toContain('role="listbox"');
  });
});

describe("<OpOmnibox> — no results state", () => {
  it('shows "Sin coincidencias en tu jurisdicción" after an empty search', () => {
    const html = renderWithState({
      query: "zzz",
      results: EMPTY,
      open: true,
      loading: false,
      activeIndex: -1,
      searched: true,
    });
    expect(html).toContain('role="listbox"');
    expect(html).toContain("Sin coincidencias en tu jurisdicción");
  });

  // search/omnibox-upgrade: admin/govt CAN now search pets (jurisdiction-scoped
  // — see lib/infra/omnibox-search.ts searchAdminGovtPets), so the generic hint
  // must advertise the DIM- token format alongside case/denuncia codes.
  it("offers the DIM- format to operators on a free-text miss", () => {
    const html = renderWithState({
      query: "zzz",
      results: EMPTY,
      open: true,
      loading: false,
      activeIndex: -1,
      searched: true,
    });
    expect(html).toContain("DIM-…");
    expect(html).toContain("CAS-…");
    expect(html).toContain("DEN-…");
  });

  // A pasted DIM token that misses is now an ORDINARY jurisdiction-scoped miss
  // (the pet-directory fence this used to name is gone — pets are searchable).
  it("reads a DIM-token miss as a normal jurisdiction-scoped miss (no fence copy)", () => {
    const html = renderWithState({
      query: "DIM-PAMP-0001",
      results: EMPTY,
      open: true,
      loading: false,
      activeIndex: -1,
      searched: true,
    });
    expect(html).not.toContain("no accede al padrón de mascotas");
    expect(html).toContain("No encontramos esa mascota en tu jurisdicción.");
  });
});

describe("<OpOmnibox> — loading state", () => {
  it("shows an inline spinner label while loading", () => {
    const html = renderWithState({
      query: "luna",
      results: EMPTY,
      open: true,
      loading: true,
      activeIndex: -1,
      searched: false,
    });
    expect(html).toContain("Buscando…");
  });
});

describe("<OpOmnibox> — grouped results", () => {
  const results: OmniboxResults = {
    pets: [
      {
        type: "pet",
        id: "p1",
        publicToken: "DIM-AAAA-BBBB",
        name: "Luna",
        species: "dog",
        href: "/mis-mascotas/DIM-AAAA-BBBB",
      },
    ],
    persons: [
      {
        type: "person",
        id: "u1",
        displayName: "Juan Pérez",
        role: "owner",
        href: "/gob/directorio?registro=usuarios&q=Juan%20P%C3%A9rez",
      },
    ],
    cases: [
      {
        type: "case",
        id: "c1",
        publicCode: "CASO-2026-001",
        caseKind: "bite_incident",
        status: "open",
        href: "/gob/casos",
      },
    ],
    total: 3,
  };

  it("renders a listbox with grouped options by type", () => {
    const html = renderWithState({
      query: "luna",
      results,
      open: true,
      loading: false,
      activeIndex: -1,
      searched: true,
    });
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    // Group headings
    expect(html).toContain("Mascotas");
    expect(html).toContain("Personas");
    expect(html).toContain("Casos");
    // Result labels
    expect(html).toContain("Luna");
    expect(html).toContain("Juan Pérez");
    expect(html).toContain("CASO-2026-001");
  });
});
