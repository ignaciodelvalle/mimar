// Smoke test for <LnPhoto> markup.
//
// LnPhoto uses plain <img> and no browser APIs, so renderToStaticMarkup works.
// Assertions:
//  - ln-* token present in markup
//  - zero occurrences of gob-* classes

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LnPhoto } from "./Photo";

function render(props: Parameters<typeof LnPhoto>[0]): string {
  return renderToStaticMarkup(<LnPhoto {...props} />);
}

describe("<LnPhoto>", () => {
  it("renders without throwing for all statuses", () => {
    for (const status of ["ok", "lost", "found", "deceased"] as const) {
      expect(() => render({ status, alt: "Rex" })).not.toThrow();
    }
  });

  it("contains ln-* token classes and zero gob-* classes (ok, no src)", () => {
    const html = render({ status: "ok", alt: "Rex" });
    expect(html).toContain("ln-");
    expect(html).not.toContain("gob-");
  });

  it("contains ln-* token classes and zero gob-* classes (lost, with src)", () => {
    const html = render({ status: "lost", alt: "Max", src: "/photo.jpg" });
    expect(html).toContain("ln-");
    expect(html).not.toContain("gob-");
  });

  it("renders initials when no src provided", () => {
    const html = render({ status: "ok", alt: "Firulais" });
    expect(html).toContain("FI");
  });

  it("renders status pill for lost", () => {
    const html = render({ status: "lost", alt: "Rex" });
    expect(html).toContain("perdida");
  });

  it("renders status pill for found", () => {
    const html = render({ status: "found", alt: "Rex" });
    expect(html).toContain("encontrada");
  });

  it("renders status pill for deceased", () => {
    const html = render({ status: "deceased", alt: "Rex" });
    expect(html).toContain("en memoria");
  });

  it("renders no badge for ok status", () => {
    const html = render({ status: "ok", alt: "Rex" });
    expect(html).not.toContain("perdida");
    expect(html).not.toContain("encontrada");
    expect(html).not.toContain("en memoria");
  });
});
