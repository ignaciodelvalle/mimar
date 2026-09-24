// @vitest-environment jsdom
//
// Tests for <CredentialQr> — the credential QR drawn in the BROWSER
// (native-readiness Track 2 / RN-5 F3: "the QR becomes a pure function of a
// cached string").
//
// Three things are pinned here:
//   1. It is a real, accessible <svg> — role="img" with an es-AR name.
//   2. It is DETERMINISTIC and correctly dimensioned: same value → same `d`,
//      and the viewBox is the symbol's module count plus a 1-module quiet zone
//      on each side (the `margin: 1` the server-rendered QR used).
//   3. Source pins for what T2-3 actually moved: no dangerouslySetInnerHTML in
//      the component, the component is a client component, and neither page
//      still imports `qrcode` or hand-builds the credential URL.

import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";

import { CredentialQr } from "./CredentialQr";

const ROOT = join(__dirname, "..", "..");
const read = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

const COMPONENT = "components/ui/CredentialQr.tsx";
const HERO_PAGE = "app/(app)/mis-mascotas/[publicToken]/page.tsx";
const ONBOARDING_PAGE = "app/(app)/mis-mascotas/nueva/[publicToken]/credencial/page.tsx";

// A flagship-shaped credential URL. At level "M" this encodes to a version-3
// symbol — 29 modules — so the rendered viewBox is 29 + 2 (quiet zone) = 31.
const VALUE = "https://www.mimar.com.ar/p/DIM-PAMP-0001";
const MODULES = 29;
const EXTENT = MODULES + 2;

function qr(props: Partial<ComponentProps<typeof CredentialQr>> = {}) {
  return (
    <CredentialQr
      value={VALUE}
      size={76}
      label="Código QR de la credencial pública de Pampa"
      {...props}
    />
  );
}

describe("<CredentialQr> — accessible svg", () => {
  it("renders role=img with the es-AR label as its accessible name", () => {
    render(qr());
    const svg = screen.getByRole("img", {
      name: "Código QR de la credencial pública de Pampa",
    });
    expect(svg.tagName.toLowerCase()).toBe("svg");
  });

  it("writes size to the intrinsic width/height attributes (CSS still overrides)", () => {
    // These are SVG PRESENTATION attributes — the credential hero's
    // `.ln-qr-frame svg { width: 76px }` (104px at md) outranks them in the
    // cascade, so `size` sets the pre-CSS box only.
    const { container } = render(qr({ size: 240 }));
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("240");
    expect(svg?.getAttribute("height")).toBe("240");
  });

  it("keeps the ink at maximum contrast and merges an extra className", () => {
    // `text-qr-ink` is a design token (`--color-qr-ink` in app/globals.css
    // @theme) pinned to true black — NOT `text-black`, which is a raw Tailwind
    // colour that `lint:tokens` cannot see because it carries no numeric shade,
    // and NOT `--color-ln-ink` (#1b2a33), which is the document's reading ink.
    // A QR is read by a camera: the dark modules must stay #000.
    const { container } = render(qr({ className: "block" }));
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toBe("text-qr-ink block");
    expect(container.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });

  it("the token is defined, is true black, and is the only place the QR gets its ink", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/--color-qr-ink:\s*#000(?:000)?;/);
    const source = read(COMPONENT);
    expect(source).toContain("text-qr-ink");
    // The raw-colour utility must not come back under any spelling.
    expect(source).not.toMatch(/\btext-black\b/);
    expect(source).not.toMatch(/text-\[#0{3,6}\]/);
  });
});

describe("<CredentialQr> — deterministic encoding", () => {
  it("sizes the viewBox to the module count plus a 1-module quiet zone", () => {
    const { container } = render(qr());
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe(`0 0 ${EXTENT} ${EXTENT}`);
  });

  it("produces the same path for the same value across two renders", () => {
    const first = render(qr());
    const a = first.container.querySelector("path")?.getAttribute("d");
    first.unmount();

    const second = render(qr());
    const b = second.container.querySelector("path")?.getAttribute("d");

    expect(a).toBeTruthy();
    expect(a).toBe(b);
    // Every subpath is a closed, filled module run inside the symbol.
    expect(a).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
  });

  it("encodes the value — a different URL yields a different path", () => {
    const mine = render(qr());
    const a = mine.container.querySelector("path")?.getAttribute("d");
    mine.unmount();

    const other = render(qr({ value: "https://www.mimar.com.ar/p/DIM-PAMP-0002" }));
    expect(other.container.querySelector("path")?.getAttribute("d")).not.toBe(a);
  });

  it("honours the error-correction level (H needs a larger symbol than M)", () => {
    const m = render(qr());
    const mExtent = m.container.querySelector("svg")?.getAttribute("viewBox");
    m.unmount();

    const h = render(qr({ errorCorrectionLevel: "H" }));
    expect(h.container.querySelector("svg")?.getAttribute("viewBox")).not.toBe(mExtent);
  });
});

// Source pins — these defend the POINT of T2-3, which no rendered-output
// assertion can see: the QR stopped being produced on the server.
//
// Each pin matches the SYNTAX of the banned thing (`prop=`, `from "…"`), not
// its name: a pin that matched the bare identifier would fire on the prose that
// explains why the identifier is banned, which teaches the next author to
// delete the explanation rather than obey the rule.
const INJECTS_RAW_HTML = /dangerouslySetInnerHTML\s*=/;
// Any way of reaching the package counts: static import, require, dynamic
// `import(`, and any subpath (`qrcode/lib/server`). A reviewer measured that
// the narrower `["']qrcode["']` let both `import("qrcode")` and a subpath
// import into a page slip past the pin.
const IMPORTS_QRCODE = /(?:from|require\(|import\()\s*["']qrcode(?:\/[^"']*)?["']/;
const DEEP_IMPORTS_QRCODE = /(?:from|require\(|import\()\s*["']qrcode\//;

describe("CredentialQr — source pins", () => {
  it("is a client component and injects no markup", () => {
    const source = read(COMPONENT);
    expect(source.startsWith('"use client";')).toBe(true);
    expect(source).not.toMatch(INJECTS_RAW_HTML);
    // The package's SVG renderer is internals, not API — the path serializer
    // is re-implemented locally on purpose.
    expect(source).not.toMatch(DEEP_IMPORTS_QRCODE);
  });

  it("neither credential page still encodes a QR server-side", () => {
    for (const page of [HERO_PAGE, ONBOARDING_PAGE]) {
      const source = read(page);
      expect(source, `${page} must not import qrcode`).not.toMatch(IMPORTS_QRCODE);
      expect(source, `${page} must not inject markup`).not.toMatch(INJECTS_RAW_HTML);
    }
  });

  it("both credential pages build the QR URL with credentialQrUrl(), never by hand", () => {
    // Invariant #1: the QR must encode an ABSOLUTE URL. credentialQrUrl() is
    // the single helper that can never return a host-less one; the onboarding
    // page used to assemble the string itself from resolveSiteUrl().
    for (const page of [HERO_PAGE, ONBOARDING_PAGE]) {
      const source = read(page);
      expect(source, `${page} must use credentialQrUrl()`).toContain("credentialQrUrl(");
      expect(source, `${page} must not hand-build the /p/ URL`).not.toMatch(
        /\$\{[A-Za-z.]*[Uu]rl\}\/p\//,
      );
    }
  });
});
