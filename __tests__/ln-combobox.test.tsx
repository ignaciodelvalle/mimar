// @vitest-environment jsdom
//
// Component tests for the shared <LnCombobox> primitive (extracted 2026-07-18
// from LocalityPickerAcross + VaccinationForm's vaccine field — see
// __tests__/vaccination-combobox.test.tsx and
// __tests__/location-fields-anon-search.test.tsx for the call-site contracts).
//
// Covers what the shell itself owns: the WAI-ARIA combobox wiring, keyboard
// nav, the mouse-select-before-blur pattern, and the two injection points
// (`items`/render-injection via `renderItem`, and the `emptyState` slot) —
// NOT any matching algorithm, which stays caller-owned.

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LnCombobox } from "@/components/ui/LnCombobox";

// jsdom has no matchMedia; LnInput's focus handler calls it.
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => cleanup());

type Item = { id: string; label: string };

const ITEMS: Item[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta" },
  { id: "c", label: "Gamma" },
];

// Minimal controlled harness — mirrors how a real caller wires value/open/items.
function Harness({
  items = ITEMS,
  emptyState,
  onSelect = vi.fn(),
}: {
  items?: Item[];
  emptyState?: React.ReactNode;
  onSelect?: (item: Item) => void;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <LnCombobox<Item>
      aria-label="Test combobox"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        setOpen(true);
      }}
      onFocus={() => setOpen(true)}
      items={items}
      getItemKey={(i) => i.id}
      onSelect={(i) => {
        setValue(i.label);
        setOpen(false);
        onSelect(i);
      }}
      open={open}
      onOpenChange={setOpen}
      emptyState={emptyState}
      renderItem={(i, { active }) => (
        <span data-active={active} data-testid={`item-${i.id}`}>
          {i.label}
        </span>
      )}
    />
  );
}

describe("<LnCombobox> — WAI-ARIA combobox wiring", () => {
  it("renders role=combobox with aria-autocomplete and collapsed aria-expanded when closed", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a role=listbox with role=option rows on focus", () => {
    render(<Harness />);
    fireEvent.focus(screen.getByRole("combobox"));

    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("sets aria-activedescendant to the active option's id", () => {
    render(<Harness />);
    fireEvent.focus(screen.getByRole("combobox"));

    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id);
  });
});

describe("<LnCombobox> — keyboard nav", () => {
  it("ArrowDown/ArrowUp move the active option (clamped at the edges)", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);

    fireEvent.keyDown(input, { key: "ArrowUp" }); // clamps at 0
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("Alpha");
  });

  it("Enter selects the active option and calls onSelect", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(ITEMS[1]);
    expect(input).toHaveValue("Beta");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Escape closes the list without changing the value", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveValue("");
  });

  it("ignores keyboard nav when the list is closed", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox");
    // Not focused/opened — ArrowDown/Enter must be no-ops.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("");
  });
});

describe("<LnCombobox> — mouse select", () => {
  it("selects on mousedown (fires before blur closes the list)", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);

    fireEvent.mouseDown(screen.getByTestId("item-c"));

    expect(onSelect).toHaveBeenCalledWith(ITEMS[2]);
    expect(input).toHaveValue("Gamma");
  });
});

describe("<LnCombobox> — render injection", () => {
  it("renders each option via the caller's renderItem, marking the active one", () => {
    render(<Harness />);
    fireEvent.focus(screen.getByRole("combobox"));

    expect(screen.getByTestId("item-a")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("item-b")).toHaveAttribute("data-active", "false");
  });
});

describe("<LnCombobox> — empty-state slot", () => {
  it("renders no popup at all when items is empty and no emptyState is supplied", () => {
    render(<Harness items={[]} />);
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders the emptyState slot inside the listbox when items is empty", () => {
    render(<Harness items={[]} emptyState={<p data-testid="empty">Sin resultados.</p>} />);
    fireEvent.focus(screen.getByRole("combobox"));

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByTestId("empty")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
