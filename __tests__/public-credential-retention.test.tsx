// @vitest-environment jsdom
//
// A disclosed phone number must not outlive the toggle that promised otherwise.
//
// WHY (closing report M8 / fix queue row 17, 2026-08-22): the owner marks
// Firulais lost and turns on name, phone and last location. `app/sitemap.ts`
// hands `/p/{token}` to crawlers daily at priority 0.85, and `/perdidas` sits in
// the site-wide footer linking to every credential — so a crawler arrives either
// way. When the dog turns up and the owner flips the toggles off, the LIVE page
// changes instantly and the search snippet and the archived copy do not.
//
// Verified: there was no indexing directive in any of the five possible places —
// no robots.ts, no robots.txt, `X-Robots-Tag` scoped to /denuncias only, nothing
// in the page or layout metadata, no headers block in vercel.json. The `no-store`
// that IS there is a CACHE directive, not an indexing one; Google honours
// `noarchive`/`nosnippet` for this, not `no-store`. The personal data really is
// in the HTML the crawler receives, `tel:` link included.
//
// WHAT IS AND IS NOT BEING DECIDED HERE. "Should lost pets be indexable?" is
// already decided — YES. The PII audit of 2026-07-04 rated exactly the sitemap
// line as Info, "expected for reunification SEO", and finding the dog is the
// whole point of the surface. Two refuted sub-claims shaped this fix: the
// sitemap is NOT the vector (removing the entry changes nothing while /perdidas
// links every credential from the footer), and the toggle copy does NOT
// over-promise (the phrase the finding quoted does not exist; the copy was
// rewritten on purpose). What is genuinely new is RETENTION and REVOCATION.
//
// So: keep them indexable, stop third parties keeping a copy, and TELL THE OWNER
// the truth — silence about permanence is the real gap.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import PrivacidadPage from "@/app/(public)/privacidad/page";
import robots from "@/app/robots";
import { LostDisclosureCard } from "@/components/pet-profile/LostDisclosureCard";
import nextConfig from "@/next.config";

type HeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

async function headerRules(): Promise<HeaderRule[]> {
  const fn = nextConfig.headers;
  if (typeof fn !== "function") throw new Error("next.config.ts declares no headers()");
  return (await fn()) as HeaderRule[];
}

describe("the public credential is indexable but not archivable", () => {
  it("X-Robots-Tag on /p/:path* carries noarchive AND nosnippet", async () => {
    const rules = await headerRules();
    const rule = rules.find((r) => r.source === "/p/:path*");
    expect(rule, "no header rule for the public credential subtree").toBeDefined();

    const robotsTag = rule?.headers.find((h) => h.key.toLowerCase() === "x-robots-tag");
    expect(robotsTag, "/p/:path* has headers but no X-Robots-Tag").toBeDefined();

    const value = (robotsTag?.value ?? "").toLowerCase();
    // noarchive: no cached copy. nosnippet: no text excerpt in the result page —
    // the snippet is where "Lo busca Juan · +54 9 11 …" would live.
    expect(value).toContain("noarchive");
    expect(value).toContain("nosnippet");
  });

  it("it does NOT carry noindex — a lost pet has to be findable", async () => {
    const rules = await headerRules();
    const rule = rules.find((r) => r.source === "/p/:path*");
    const value = (
      rule?.headers.find((h) => h.key.toLowerCase() === "x-robots-tag")?.value ?? ""
    ).toLowerCase();
    // `noindex` would take the credential out of results entirely and defeat the
    // reunification path the PO explicitly kept. Word-boundary match so
    // "noindex" is not read out of some longer token.
    expect(/\bnoindex\b/.test(value)).toBe(false);
    expect(/\bnofollow\b/.test(value)).toBe(false);
  });

  it("the denuncia rules keep their stricter directive — this must not have widened", async () => {
    const rules = await headerRules();
    for (const source of ["/denuncias/codigo/:path*", "/denuncias/seguimiento/:path*"]) {
      const value =
        rules
          .find((r) => r.source === source)
          ?.headers.find((h) => h.key.toLowerCase() === "x-robots-tag")?.value ?? "";
      expect(value.toLowerCase(), `${source} lost its noindex`).toContain("noindex");
    }
  });
});

describe("app/robots.ts", () => {
  it("exists and leaves the credential and lost-pet surfaces crawlable", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const disallow = rules.flatMap((r) =>
      Array.isArray(r?.disallow) ? r.disallow : r?.disallow ? [r.disallow] : [],
    );

    // Non-vacuity: the file must actually disallow SOMETHING, or it is proving
    // nothing about the paths it leaves alone.
    expect(disallow.length).toBeGreaterThan(0);

    for (const open of ["/p/", "/perdidas", "/adoptar"]) {
      expect(
        disallow.some((d) => open.startsWith(d.replace(/\*$/, ""))),
        `${open} must stay crawlable — it is the reunification surface`,
      ).toBe(false);
    }
  });

  it("declares the sitemap from NEXT_PUBLIC_SITE_URL, and never throws without it", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://mimar.example.ar");
    expect(robots().sitemap).toBe("https://mimar.example.ar/sitemap.xml");

    // Unset: still a VALID robots.txt, just without the Sitemap: line. A
    // robots.txt that 500s is read by crawlers as "no restrictions at all",
    // which is strictly worse than one missing a hint.
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(() => robots()).not.toThrow();
    expect(robots().sitemap).toBeUndefined();
    expect(robots().rules).toBeTruthy();

    vi.unstubAllEnvs();
  });

  it("keeps the authenticated and denuncia surfaces out", () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const disallow = rules.flatMap((r) =>
      Array.isArray(r?.disallow) ? r.disallow : r?.disallow ? [r.disallow] : [],
    );
    for (const closed of ["/api/", "/admin", "/gob", "/denuncias/codigo"]) {
      expect(
        disallow.some((d) => closed.startsWith(d.replace(/\*$/, ""))),
        `${closed} should not be crawled`,
      ).toBe(true);
    }
  });
});

describe("the owner is told what publishing actually means", () => {
  const prefs = {
    discloseFirstNameWhenLost: true,
    disclosePhoneWhenLost: true,
    discloseEmailWhenLost: false,
    discloseLastLocationWhenLost: true,
    allowFinderFormWhenLost: true,
    discloseCaretakerContactWhenLost: false,
  };

  it("LostDisclosureCard says the toggle does not un-publish what was already taken", () => {
    render(
      <LostDisclosureCard
        prefs={prefs}
        toggleAction={vi.fn().mockResolvedValue(undefined)}
        publicHref="/p/DIM-TEST-0001"
        ownerFirstName="Juan"
        alertsOriginShelter={false}
      />,
    );

    // The two facts that were missing, not a general privacy homily: third
    // parties can copy/cache what is published, and turning the toggle off does
    // not reach those copies.
    const note = screen.getByTestId("lost-disclosure-permanence");
    expect(note.textContent ?? "").toMatch(/copiar|copia/i);
    expect(note.textContent ?? "").toMatch(/apag/i);
  });

  it("the privacy policy stops describing a scan-only world", () => {
    render(<PrivacidadPage />);
    const body = document.body.textContent ?? "";
    // It used to say only "cualquier persona que escanee el código QR ve…",
    // with not a word about search engines or archives.
    expect(body).toMatch(/buscador|buscadores/i);
    expect(body).toMatch(/copia|copias|archiv/i);
  });
});
