// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanoramaRail, type RailItem } from "@/components/panorama/PanoramaRail";

afterEach(() => cleanup());

// A controlled harness — the console owns `open`; this wrapper mirrors it.
function ControlledRail({ badge = 0 }: { badge?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const items: RailItem[] = [
    {
      id: "filtro",
      icon: "filtro",
      label: "Filtro",
      kind: "panel",
      badge,
      detail,
      onDetailChange: setDetail,
      render: (d) => <p>{d ? "cuerpo detalle" : "cuerpo simple"}</p>,
    },
  ];
  return <PanoramaRail items={items} open={open} onOpenChange={setOpen} />;
}

describe("PanoramaRail — panel open/close state", () => {
  it("opens the panel on trigger click and closes on a second click", () => {
    render(<ControlledRail />);
    const trigger = screen.getByRole("button", { name: "Filtro" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("cuerpo simple")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("cuerpo simple")).toBeVisible();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("cuerpo simple")).not.toBeInTheDocument();
  });

  it("Escape closes the open panel", () => {
    render(<ControlledRail />);
    fireEvent.click(screen.getByRole("button", { name: "Filtro" }));
    expect(screen.getByText("cuerpo simple")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("cuerpo simple")).not.toBeInTheDocument();
  });

  it("the Simple/Detalle toggle swaps the panel body tier", () => {
    render(<ControlledRail />);
    fireEvent.click(screen.getByRole("button", { name: "Filtro" }));
    expect(screen.getByText("cuerpo simple")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Modo detalle de Filtro" }));
    expect(screen.getByText("cuerpo detalle")).toBeVisible();
    expect(screen.queryByText("cuerpo simple")).not.toBeInTheDocument();
  });

  it("renders the badge only when the count is > 0", () => {
    const { rerender } = render(<ControlledRail badge={0} />);
    expect(screen.queryByText("3")).not.toBeInTheDocument();
    rerender(<ControlledRail badge={3} />);
    expect(screen.getByText("3")).toBeVisible();
  });

  it("fires an action item's onClick without opening a panel", () => {
    const onClick = vi.fn();
    function ActionRail() {
      const [open, setOpen] = useState<string | null>(null);
      const items: RailItem[] = [
        { id: "actualizar", icon: "actualizar", label: "Actualizar", kind: "action", onClick },
      ];
      return <PanoramaRail items={items} open={open} onOpenChange={setOpen} />;
    }
    render(<ActionRail />);
    const btn = screen.getByRole("button", { name: "Actualizar" });
    expect(btn).not.toHaveAttribute("aria-expanded");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
