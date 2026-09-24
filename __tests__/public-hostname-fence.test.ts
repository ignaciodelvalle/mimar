// Every hostname the product presents AS ITS OWN must be a domain we own.
//
// WHY THIS EXISTS (measured 2026-09-07)
// ---------------------------------------------------------------------------
// Two constants named `mimar.ar`, a domain that DOES NOT EXIST: 8.8.8.8 and
// 1.1.1.1 both answer `Non-existent domain` — no NS, no A, no MX.
//
//   lib/analytics/export-attribution.ts  PUBLIC_BRAND_DOMAIN
//   lib/infra/site-url.ts                CANONICAL_SITE_URL
//
// The first is unconditional: `documentAttributionLine()` prints it at the
// foot of EVERY exported PDF — the Ley 14.346 denuncia handed to a fiscal, the
// PPP certificate, the travel document. No env var is involved and no
// deployment can correct it. Every one of those instruments went out carrying
// a domain a reader cannot reach, under a footer whose whole job is to say
// where to go and verify the thing.
//
// The second is the fallback `resolveSiteUrl()` uses when NEXT_PUBLIC_SITE_URL
// is unset, empty or whitespace-only — so it is what a credential QR encodes
// in exactly the case that module exists to protect. A QR is worse than a
// printed line: nobody reads it before scanning, and it fails silently.
//
// The domain the project owns is `mimar.com.ar` (apex and `www.` both resolve;
// `www.mimar.com.ar` is the production origin of record). Its sibling fence
// `__tests__/contact-email-domain-fence.test.tsx` covers the MAILBOX half of
// the same class — an address at a domain we cannot receive mail at. This file
// covers the HOSTNAME half: a domain we do not serve from, printed on a legal
// document or encoded in a credential.
//
// WHY A SIBLING FILE AND NOT A BLOCK IN THAT ONE
// ---------------------------------------------------------------------------
// They share an idea (an explicit ownership registry) and nothing else. That
// fence runs in jsdom because it renders /privacidad; this one is a pure
// filesystem scan. That one scans app/ + components/; both bugs here live in
// lib/, so this one must scan lib/ and src/ too — different roots mean
// different non-vacuity floors, and floors for two different corpora in one
// file are floors nobody can read. Their exemptions have no overlap at all:
// input placeholders and RFC 2606 mailboxes there, this app's own route table
// here. The two are wired together at the one place they genuinely touch —
// OWNED_MAIL_DOMAINS must be contained in OWNED_WEB_DOMAINS, asserted below —
// so they cannot drift into disagreeing about what "ours" means.
//
// WHAT THIS FENCE BANS, AND WHY IT IS NOT "no mimar.ar"
// ---------------------------------------------------------------------------
// A fence against the dead spelling passes the day someone types the NEXT dead
// one — `mimar.gob.ar` before delegation, a typo'd `mimra.com.ar`, a personal
// domain. This repo has already paid for that mistake ("a fence that
// enumerates spellings misses one"). So the subject here is the CLASS, caught
// with two teeth that between them cover both how the bug got in and how it
// stayed in:
//
//   RULE A — the registry is honest. Every domain the product declares as its
//   own must be in OWNED_WEB_DOMAINS, and the check runs through the PUBLIC
//   API (resolveSiteUrl, credentialQrUrl, documentAttributionLine) rather than
//   against a pinned literal, so it reads the value a user would actually get.
//
//   RULE B — there is only one origin. No shipped file may hardcode an
//   absolute URL pointing at one of THIS APP'S OWN routes. The route table is
//   derived from the app/ router tree at scan time, so it cannot rot, and no
//   ownership judgement enters the scan: a hardcoded self-link is the defect
//   whatever domain it names. That is deliberate. `mimar.ar` survived this
//   long precisely because the origin had been retyped in several places (the
//   module header records three divergent fallbacks), so fixing the value
//   without closing the mechanism would just buy time until the next one.
//
// A third-party allowlist was considered and rejected. Classifying all 25
// external hosts in the tree (argentina.gob.ar, wa.me, tile.openstreetmap.org,
// w3.org …) would fail the next legitimate legal citation added to
// lib/reference/, and a fence that cries wolf on ordinary work gets widened
// until it is decoration. Rules A and B need no such list.
//
// MEASURED FLOORS (why this fence is not vacuous)
// ---------------------------------------------------------------------------
// Against the tree on 2026-09-07:
//   2286 files scanned under app/ + components/ + lib/ + src/
//     61 absolute URL literals found, across 25 distinct hosts
//     44 top-level route segments derived from app/
//      1 self-link violation — CompartirOrgSheet.tsx, fixed by this change
// Rule B's live corpus is 0 once that is fixed, which is what a green fence
// looks like; the floors and the controls below are what keep the 0 honest. A
// broken extractor, a renamed root or an empty route table would each make
// this scan match nothing and stay green forever, so all three are floored.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PUBLIC_BRAND_DOMAIN, documentAttributionLine } from "@/lib/analytics/export-attribution";
import {
  CANONICAL_DOMAIN,
  OWNED_WEB_DOMAINS,
  credentialQrUrl,
  resolveSiteUrl,
} from "@/lib/infra/site-url";
import { OWNED_MAIL_DOMAINS } from "@/lib/ui/contact";

const REPO_ROOT = join(__dirname, "..");

/** Shipped surfaces: pages, components, and the libraries they render from. */
const ROOTS = ["app", "components", "lib", "src"];

/**
 * True when `host` is, or is a subdomain of, a domain we own. Subdomains count
 * because owning `mimar.com.ar` means owning `www.mimar.com.ar` — the fence is
 * about the registrable domain, not about which host record points where.
 */
function isOwnedHost(host: string): boolean {
  const h = host.toLowerCase();
  return (OWNED_WEB_DOMAINS as readonly string[]).some((d) => h === d || h.endsWith(`.${d}`));
}

/** Domain-shaped tokens in a rendered string, e.g. the PDF attribution line. */
const DOMAIN_TOKEN =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}\b/g;

function domainsNamedIn(text: string): string[] {
  return [...text.toLowerCase().matchAll(DOMAIN_TOKEN)].map((m) => m[0]);
}

// --- Rule B: the app's own routes, derived from the router tree -------------

/**
 * Top-level path segments the Next app router actually serves. Route groups
 * `(marketing)` are transparent in the URL so they are unwrapped; `_private`
 * folders and `[dynamic]` segments are not literals anyone can hardcode.
 */
function appRouteSegments(): string[] {
  const segments = new Set<string>();
  function walk(dir: string): void {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name.startsWith("_") || name.startsWith("[") || name === "node_modules") continue;
      if (name.startsWith("(") && name.endsWith(")")) {
        walk(join(dir, name));
        continue;
      }
      segments.add(name);
    }
  }
  walk("app");
  return [...segments].sort();
}

const ROUTE_SEGMENTS = appRouteSegments();

/** Strip comments so a URL discussed in prose is not read as shipped output. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("//") && !t.startsWith("*");
    })
    .join("\n");
}

const ABSOLUTE_URL =
  /https?:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)((?:\/[^\s"'`)\]}<>]*)?)/g;

type UrlLiteral = { url: string; host: string; firstSegment: string };

function absoluteUrlsIn(source: string): UrlLiteral[] {
  return [...stripComments(source).matchAll(ABSOLUTE_URL)].map((m) => ({
    url: m[0],
    host: (m[1] ?? "").toLowerCase(),
    firstSegment: (m[2] ?? "").replace(/^\//, "").split(/[/?#]/)[0] ?? "",
  }));
}

/**
 * The rule, as one function, so the controls below exercise the real thing: a
 * hardcoded absolute URL into one of our own routes, whoever it names.
 */
function selfLinkViolationsIn(source: string): string[] {
  return absoluteUrlsIn(source)
    .filter((u) => u.firstSegment !== "" && ROUTE_SEGMENTS.includes(u.firstSegment))
    .map((u) => u.url);
}

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, root), {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    const dir = entry.parentPath ?? entry.path ?? root;
    if (dir.includes("node_modules")) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

const SOURCE_FILES = ROOTS.flatMap(collectSourceFiles);

const SCAN = SOURCE_FILES.map((file) => {
  const source = readFileSync(file, "utf8");
  return {
    file: file.replace(/\\/g, "/").replace(`${REPO_ROOT.replace(/\\/g, "/")}/`, ""),
    urls: absoluteUrlsIn(source),
    selfLinks: selfLinkViolationsIn(source),
  };
});

describe("RULE A — every domain the product claims as its own is a domain we own", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("the owned-domain registry is short, lowercase and non-empty", () => {
    // A domain list nobody can read is a domain list nobody reviews.
    expect(OWNED_WEB_DOMAINS.length).toBeGreaterThan(0);
    expect(OWNED_WEB_DOMAINS.length).toBeLessThanOrEqual(4);
    for (const d of OWNED_WEB_DOMAINS) {
      expect(d, "an owned domain must be a bare lowercase registrable hostname").toMatch(
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
      );
      expect(d, "an owned domain is a domain, not an origin").not.toContain("/");
    }
    expect(OWNED_WEB_DOMAINS).toContain(CANONICAL_DOMAIN);
  });

  it("we do not claim to receive mail at a domain we do not own", () => {
    // The one place this fence and the mailbox fence genuinely touch. Mail and
    // web ownership are different facts (MX vs A), related by containment.
    for (const mail of OWNED_MAIL_DOMAINS) {
      expect(
        isOwnedHost(mail),
        `${mail} is in OWNED_MAIL_DOMAINS but not under any OWNED_WEB_DOMAINS entry`,
      ).toBe(true);
    }
  });

  it("the domain printed at the foot of every exported PDF is one we own", () => {
    // The Ley 14.346 denuncia, the PPP certificate and the travel document all
    // sign off with this line, unconditionally — no env var can correct it.
    expect(isOwnedHost(PUBLIC_BRAND_DOMAIN), `PUBLIC_BRAND_DOMAIN = ${PUBLIC_BRAND_DOMAIN}`).toBe(
      true,
    );

    const line = documentAttributionLine("DEN-2026-000123");
    const unowned = domainsNamedIn(line).filter((d) => !isOwnedHost(d));
    expect(unowned, `the PDF attribution footer names a domain we do not own: ${line}`).toEqual([]);
  });

  it.each([
    ["unset", undefined as unknown as string],
    ["set-but-empty", ""],
    ["whitespace-only", "   "],
  ])("the site-url fallback for a %s NEXT_PUBLIC_SITE_URL is a domain we own", (_label, value) => {
    // Read through the public API, not off the constant: this is the origin a
    // user actually gets, and the case a credential QR encodes.
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", value);
    const origin = resolveSiteUrl();
    expect(origin.startsWith("https://"), `${origin} is not an https origin`).toBe(true);
    expect(isOwnedHost(new URL(origin).hostname), `resolveSiteUrl() fell back to ${origin}`).toBe(
      true,
    );
  });

  it("a credential QR built without NEXT_PUBLIC_SITE_URL encodes a resolvable host", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    const url = credentialQrUrl("DIM-PAMP-0001");
    expect(isOwnedHost(new URL(url).hostname), `a QR would encode ${url}`).toBe(true);
  });
});

describe("RULE B — the app's own origin has exactly one source", () => {
  it("no shipped file hardcodes an absolute URL into one of our own routes", () => {
    const offenders = SCAN.filter((s) => s.selfLinks.length > 0).map(
      (s) => `${s.file} (${s.selfLinks.join(", ")})`,
    );
    expect(
      offenders,
      [
        "These files hardcode an absolute URL pointing at a route this app serves.",
        "That is a SECOND spelling of our own origin, and a second spelling is how",
        "`mimar.ar` outlived the day it was typed: it goes stale silently, on a",
        "surface (a QR, a share link, a printed footer) nobody re-reads.",
        "",
        "There is one source for the origin. Use it:",
        "  import { resolveSiteUrl, credentialQrUrl } from '@/lib/infra/site-url';",
        "  const url = `${resolveSiteUrl()}/refugios/${orgToken}`;",
        "",
        "This fires even when the domain is one we DO own — the defect is the",
        "hardcoding, not the spelling. In a client component prefer",
        "window.location.origin when mounted, with resolveSiteUrl() as the SSR",
        "branch, so the link matches the origin the visitor is already on.",
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("the fence scans a real corpus (non-vacuity floors)", () => {
  // Measured 2026-09-07: 2286 files, 61 URL literals, 25 hosts, 44 routes.
  it("scans the shipped surfaces — at least 1800 files", () => {
    expect(SOURCE_FILES.length).toBeGreaterThanOrEqual(1800);
  });

  it("still finds absolute URLs to classify — at least 45, across at least 15 hosts", () => {
    const urls = SCAN.flatMap((s) => s.urls);
    const hosts = new Set(urls.map((u) => u.host));
    expect(
      urls.length,
      "the URL extractor matched nothing — regex or roots broken",
    ).toBeGreaterThanOrEqual(45);
    expect(hosts.size).toBeGreaterThanOrEqual(15);
  });

  it("derives a real route table — at least 30 segments including the credential route", () => {
    // An empty route table would make RULE B match nothing and pass forever.
    expect(ROUTE_SEGMENTS.length).toBeGreaterThanOrEqual(30);
    expect(ROUTE_SEGMENTS).toContain("p");
    expect(ROUTE_SEGMENTS).toContain("refugios");
    expect(ROUTE_SEGMENTS).toContain("denuncias");
  });
});

describe("the fence catches what it claims to catch (controls)", () => {
  it("flags the dead domain this bug shipped", () => {
    expect(isOwnedHost("mimar.ar")).toBe(false);
    expect(selfLinkViolationsIn('const url = "https://mimar.ar/p/DIM-PAMP-0001";')).toEqual([
      "https://mimar.ar/p/DIM-PAMP-0001",
    ]);
  });

  it("flags a domain nobody has typed yet — the point of banning the class", () => {
    // mimar.gob.ar is the plausible NEXT one: the eventual government origin,
    // not delegated. A blocklist of "mimar.ar" would wave it through.
    expect(isOwnedHost("mimar.gob.ar")).toBe(false);
    expect(isOwnedHost("mimra.com.ar")).toBe(false);
    expect(selfLinkViolationsIn('fetch("https://mimar.gob.ar/denuncias/codigo/X")')).toEqual([
      "https://mimar.gob.ar/denuncias/codigo/X",
    ]);
  });

  it("flags a hardcoded self-link even at a domain we DO own", () => {
    // The mechanism, not the spelling: retyping the origin is the defect.
    expect(selfLinkViolationsIn(`const u = "https://${CANONICAL_DOMAIN}/refugios/abc";`)).toEqual([
      `https://${CANONICAL_DOMAIN}/refugios/abc`,
    ]);
  });

  it("accepts our own domain and its subdomains as owned hosts", () => {
    expect(isOwnedHost(CANONICAL_DOMAIN)).toBe(true);
    expect(isOwnedHost(`www.${CANONICAL_DOMAIN}`)).toBe(true);
    expect(isOwnedHost(`WWW.${CANONICAL_DOMAIN.toUpperCase()}`)).toBe(true);
  });

  it("does not flag an ordinary third-party link", () => {
    // The reason there is no third-party allowlist: these must stay free.
    expect(selfLinkViolationsIn('href="https://www.argentina.gob.ar/senasa"')).toEqual([]);
    expect(selfLinkViolationsIn('href="https://wa.me/?text=hola"')).toEqual([]);
    expect(selfLinkViolationsIn('xmlns="http://www.w3.org/2000/svg"')).toEqual([]);
    expect(selfLinkViolationsIn('url("https://tile.openstreetmap.org/1/2/3.png")')).toEqual([]);
  });

  it("does not let a comment hide a self-link, nor a comment create one", () => {
    // Comment stripping must not swallow executable code on the same run: a
    // fence that finds nothing because it looks at nothing passes forever.
    expect(
      selfLinkViolationsIn(
        ["// see https://mimar.ar/p/OLD", 'const u = "https://mimar.ar/p/NEW";'].join("\n"),
      ),
    ).toEqual(["https://mimar.ar/p/NEW"]);
  });

  it("reads a template literal's path, which is the shape these bugs take", () => {
    expect(selfLinkViolationsIn("const u = `https://mimar.ar/refugios/${orgToken}`;")).toEqual([
      "https://mimar.ar/refugios/${orgToken",
    ]);
  });
});
