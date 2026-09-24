// D2 — DemoModeBanner tests.
//
// Tests the pure helpers (`shouldShowDemoBanner`, `demoBannerAppliesTo`) and
// the component, which now composes BOTH of them. Uses renderToStaticMarkup
// (the repo's component-test harness — no jsdom).
//
// `usePathname` is mocked because the component reads the page it is on. That
// mock is not scaffolding to work around a test harness — the page is now an
// INPUT to the decision, so every render here has to say which page it is, the
// same way it has to say whether the environment is a demo.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DemoModeBanner, shouldShowDemoBanner } from "@/components/ui/DemoModeBanner";
import { demoBannerAppliesTo } from "@/lib/domain/demo-mode";

const mockPathname = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
}));

beforeEach(() => {
  mockPathname.value = "/";
});

describe("shouldShowDemoBanner()", () => {
  it('returns true when env value is "true"', () => {
    expect(shouldShowDemoBanner("true")).toBe(true);
  });

  it("returns false when env value is undefined", () => {
    expect(shouldShowDemoBanner(undefined)).toBe(false);
  });

  it('returns false when env value is "false"', () => {
    expect(shouldShowDemoBanner("false")).toBe(false);
  });

  it("returns false for any other value", () => {
    expect(shouldShowDemoBanner("1")).toBe(false);
    expect(shouldShowDemoBanner("yes")).toBe(false);
    expect(shouldShowDemoBanner("")).toBe(false);
  });
});

describe("demoBannerAppliesTo() — where the disclosure has something to disclose", () => {
  it("exempts the pages that carry no records at all", () => {
    // Named `route` and not `path`: the node:path module is imported in this
    // file, and a loop variable that shadows it works here only because the
    // uses are in a different block. That is a trap left for the next editor.
    for (const route of [
      "/privacidad",
      "/terminos",
      "/cookies",
      "/accesibilidad",
      "/leyes",
      "/acerca",
      "/ayuda",
      "/sugerencias",
    ]) {
      expect(demoBannerAppliesTo(route), `${route} should be exempt`).toBe(false);
    }
  });

  it("KEEPS the banner on /privacidad's neighbours that do show data", () => {
    // The three that would be easiest to exempt by mistake, and the reason each
    // must not be. `/` puts the flagship credential and its QR on screen and
    // that pet is seeded. `/transparencia` publishes datasets computed from the
    // seeded population — it reads like a documentation page and is the single
    // page where the disclosure matters most. `/cuenta/privacidad` is a citizen
    // surface with the person's own records on it, and its name is one segment
    // away from the exempt one.
    expect(demoBannerAppliesTo("/")).toBe(true);
    expect(demoBannerAppliesTo("/transparencia")).toBe(true);
    expect(demoBannerAppliesTo("/cuenta/privacidad")).toBe(true);
  });

  it("KEEPS the banner where an account is created, which shows no data but changes state", () => {
    // "Shows no records" is not the same test as "changes nothing". A person
    // signing up here lands in THIS environment, and the banner is the only
    // thing that tells them so.
    expect(demoBannerAppliesTo("/iniciar-sesion")).toBe(true);
    expect(demoBannerAppliesTo("/crear-cuenta")).toBe(true);
  });

  it("KEEPS the banner on every operator surface", () => {
    expect(demoBannerAppliesTo("/gob")).toBe(true);
    expect(demoBannerAppliesTo("/admin")).toBe(true);
    expect(demoBannerAppliesTo("/gob/outbox")).toBe(true);
  });

  it("matches exactly, never by prefix", () => {
    // A future `/leyes/[jurisdiccion]` that resolved a real rule set would be
    // DATA. A `startsWith` check would have exempted it the day it shipped,
    // with nobody deciding to. A new page earns its exemption by being named.
    expect(demoBannerAppliesTo("/leyes/buenos-aires")).toBe(true);
    expect(demoBannerAppliesTo("/ayuda/turnos")).toBe(true);
  });

  it("normalises a trailing slash — a disclosure may not depend on how it was typed", () => {
    expect(demoBannerAppliesTo("/privacidad/")).toBe(false);
    expect(demoBannerAppliesTo("/")).toBe(true);
  });
});

describe("DemoModeBanner component", () => {
  it("renders the banner when enabled=true on a page that shows data", () => {
    const html = renderToStaticMarkup(<DemoModeBanner enabled={true} />);
    // <output> is an implicit status live region (semantic, lint-clean).
    expect(html).toContain("<output");
    expect(html).toContain("Entorno de demostración — datos sintéticos");
  });

  it("renders nothing when enabled=false", () => {
    const html = renderToStaticMarkup(<DemoModeBanner enabled={false} />);
    expect(html).toBe("");
  });

  it("renders nothing on a data-free page EVEN WHEN the environment is a demo", () => {
    // The case this whole change exists for: /privacidad is the URL Google Play
    // has on file as this app's privacy policy and account-deletion pathway. A
    // reviewer opens it and must not be told the product is a demonstration by
    // a sentence that has no data to be about.
    mockPathname.value = "/privacidad";
    expect(renderToStaticMarkup(<DemoModeBanner enabled={true} />)).toBe("");
  });

  it("still renders on /transparencia, where every figure comes from seeded data", () => {
    mockPathname.value = "/transparencia";
    const html = renderToStaticMarkup(<DemoModeBanner enabled={true} />);
    expect(html).toContain("Entorno de demostración — datos sintéticos");
  });

  it("banner is not hideable when enabled (no display:none / visibility:hidden)", () => {
    const html = renderToStaticMarkup(<DemoModeBanner enabled={true} />);
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("visibility:hidden");
  });
});

// ---------------------------------------------------------------------------
// The exemption list against the real tree
// ---------------------------------------------------------------------------

describe("every exempt path is a real page that really carries no records", () => {
  // The list above is a claim about the FILESYSTEM, and claims about the
  // filesystem rot silently. Two ways this goes wrong and neither shows up in
  // any assertion written against the function alone:
  //
  //   · a typo, or a page that gets renamed or deleted — the exemption becomes
  //     dead config and the banner quietly comes back. Safe direction, but the
  //     fix stops working and nobody is told.
  //   · a page on the list grows a database read. THAT is the dangerous one:
  //     the disclosure is now off a page that shows records, which is the exact
  //     failure this exemption was carved to avoid.
  //
  // So the rule is checked against the tree rather than against itself.

  const EXEMPT = [
    "privacidad",
    "terminos",
    "cookies",
    "accesibilidad",
    "leyes",
    "acerca",
    "ayuda",
    "sugerencias",
  ] as const;

  it("the list in demo-mode.ts and the list here have not drifted apart", () => {
    // A floor, so a shrunk DATA_FREE_PATHS cannot pass the tests below by
    // having nothing left to check.
    for (const slug of EXEMPT) {
      expect(demoBannerAppliesTo(`/${slug}`), `/${slug} dropped out of the exemption`).toBe(false);
    }
    expect(EXEMPT.length).toBeGreaterThanOrEqual(8);
  });

  it("each one resolves to a page file under app/(public)", () => {
    for (const slug of EXEMPT) {
      const file = path.join(process.cwd(), "app", "(public)", slug, "page.tsx");
      expect(existsSync(file), `${slug} is exempt but has no page at ${file}`).toBe(true);
    }
  });

  it("none of them reads the database", () => {
    // The load-bearing one. `@/db` is the only door to Postgres in this repo,
    // so importing it is the observable form of "this page shows records".
    const offenders: string[] = [];
    for (const slug of EXEMPT) {
      const src = readFileSync(
        path.join(process.cwd(), "app", "(public)", slug, "page.tsx"),
        "utf8",
      );
      if (/from\s+"@\/db"/.test(src) || /\bawait\s+db\b/.test(src)) offenders.push(slug);
    }
    expect(
      offenders,
      "these pages are exempt from the demo disclosure but now read data — either revert the read or drop them from DATA_FREE_PATHS",
    ).toEqual([]);
  });
});
