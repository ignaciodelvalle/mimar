// @vitest-environment jsdom
// Tests for CsvExportLink (Q1) — pins the blob-href lifecycle (create on
// rows, revoke on unmount), the empty-rows null render, and the download
// filename contract. jsdom lacks URL.createObjectURL, so it is stubbed.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CsvExportLink } from "./CsvExportLink";

const createObjectURL = vi.fn(() => "blob:mock-url");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL,
    revokeObjectURL,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CsvExportLink", () => {
  it("renders the download anchor with the blob href and .csv filename", () => {
    render(
      <CsvExportLink filename="casos-2026-08-02" columns={["Código"]} rows={[["CAS-0001"]]} />,
    );
    const link = screen.getByRole("link", { name: "Exportar CSV →" });
    expect(link.getAttribute("href")).toBe("blob:mock-url");
    expect(link.getAttribute("download")).toBe("casos-2026-08-02.csv");
  });

  it("builds the blob from the rendered rows", () => {
    render(<CsvExportLink filename="f" columns={["A"]} rows={[["x,y"]]} />);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls[0] as unknown[])[0] as Blob;
    expect(blob.type).toBe("text/csv;charset=utf-8");
  });

  it("renders nothing when there are no rows (no empty-file artifact)", () => {
    const { container } = render(<CsvExportLink filename="f" columns={["A"]} rows={[]} />);
    expect(container.innerHTML).toBe("");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("revokes the object URL on unmount (no leak)", () => {
    const { unmount } = render(<CsvExportLink filename="f" columns={["A"]} rows={[["1"]]} />);
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});
