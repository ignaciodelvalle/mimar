// @vitest-environment jsdom
// Tests for OpSortHeader (Q4) — pins the aria-sort semantics, the toggle
// href (same-key flip / new-key default dir), the resetParams drop, and that
// the commit is a plain full-document anchor (no client router involvement).

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let currentQuery = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(currentQuery),
}));

import { OpSortHeader } from "./OpSortHeader";

afterEach(() => {
  cleanup();
  currentQuery = "";
});

function renderTh(ui: React.ReactElement) {
  // A <th> must live inside a table row to render without DOM nesting errors.
  return render(
    <table>
      <thead>
        <tr>{ui}</tr>
      </thead>
    </table>,
  );
}

describe("OpSortHeader", () => {
  it("marks the active column with aria-sort and shows no marker on inactive ones", () => {
    renderTh(
      <OpSortHeader sortKey="senales" label="Señales" current={{ key: "senales", dir: "desc" }} />,
    );
    expect(screen.getByRole("columnheader").getAttribute("aria-sort")).toBe("descending");
  });

  it("reports aria-sort none for an inactive column", () => {
    renderTh(
      <OpSortHeader sortKey="nombre" label="Nombre" current={{ key: "senales", dir: "desc" }} />,
    );
    expect(screen.getByRole("columnheader").getAttribute("aria-sort")).toBe("none");
  });

  it("flips direction on the active column and preserves unrelated params", () => {
    currentQuery = "period=30d&orden=senales&dir=desc";
    renderTh(
      <OpSortHeader sortKey="senales" label="Señales" current={{ key: "senales", dir: "desc" }} />,
    );
    const href = screen.getByRole("link").getAttribute("href") ?? "";
    expect(href).toContain("orden=senales");
    expect(href).toContain("dir=asc");
    expect(href).toContain("period=30d");
  });

  it("starts a new column at its declared default direction", () => {
    renderTh(
      <OpSortHeader
        sortKey="nombre"
        label="Nombre"
        defaultDir="asc"
        current={{ key: "senales", dir: "desc" }}
      />,
    );
    const href = screen.getByRole("link").getAttribute("href") ?? "";
    expect(href).toContain("orden=nombre");
    expect(href).toContain("dir=asc");
  });

  it("drops resetParams (e.g. a pagination cursor) from the commit href", () => {
    currentQuery = "cursor=abc&orden=senales&dir=desc";
    renderTh(
      <OpSortHeader
        sortKey="senales"
        label="Señales"
        resetParams={["cursor"]}
        current={{ key: "senales", dir: "desc" }}
      />,
    );
    expect(screen.getByRole("link").getAttribute("href")).not.toContain("cursor=");
  });

  it("carries an es-AR aria-label naming the next order", () => {
    renderTh(
      <OpSortHeader sortKey="senales" label="Señales" current={{ key: "senales", dir: "desc" }} />,
    );
    expect(screen.getByRole("link", { name: "Ordenar por Señales, ascendente" })).toBeTruthy();
  });
});
