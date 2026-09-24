// @vitest-environment jsdom
//
// Every address the product publishes must be at a domain we can receive mail
// at.
//
// WHY THIS EXISTS (measured 2026-09-07)
// ---------------------------------------------------------------------------
// Nine lines across six files published `hola@mimar.ar` and
// `privacidad@mimar.ar`. `mimar.ar` DOES NOT EXIST: 8.8.8.8 and 1.1.1.1 both
// answered `Non-existent domain` — no NS, no MX. Every one of those addresses
// bounced. /privacidad offered its address as THE channel for exercising Ley
// 25.326 rights of access and erasure, so a person locked out of their account
// had exactly one door and it was painted on. The live domain, MX-verified at
// Resend since 2026-08-28 and the origin the site is served from, is
// `mimar.com.ar`.
//
// WHAT THIS FENCE BANS, AND WHY IT IS NOT "no mimar.ar"
// ---------------------------------------------------------------------------
// A fence that forbids the one dead spelling passes the day someone types the
// NEXT dead spelling — `mimar.gob.ar` before delegation, a typo'd
// `mimra.com.ar`, a personal domain, whatever. This repo has paid for that
// mistake before (docs: "a fence that enumerates spellings misses one").
//
// So the subject here is the CLASS: any email address a shipped file names is
// a promise that mail sent there arrives. The check is not against a blocklist
// of dead domains but against OWNED_MAIL_DOMAINS in lib/ui/contact.ts — the
// short, explicit list of domains this project controls. Anything else fails,
// including domains nobody has thought of yet. Widening the allowlist is a
// deliberate one-line edit next to the constant, reviewed as such.
//
// THE ONE EXEMPTION, AND ITS BOUNDARY
// ---------------------------------------------------------------------------
// An input `placeholder` is not a promise — `placeholder="vos@ejemplo.com"`
// shows a citizen the SHAPE of an address, and pointing it at a real inbox
// would be the bug. Placeholder attribute values are therefore stripped before
// the scan. That is a structural exemption (an HTML attribute that cannot be
// clicked), not a per-address allowlist, so it cannot be used to smuggle a
// contact address past the fence: move `hola@…` out of a placeholder and into
// anything a user can act on, and this fence fires.
//
// The second exemption is RFC 2606 §3, which reserves example.com/.net/.org
// precisely so documentation can name an address that provably cannot receive
// mail. `app/api/v1/me/caretaker-grants/commands.ts` uses one to build an API
// refusal-message table.
//
// MEASURED FLOORS (why this fence is not vacuous)
// ---------------------------------------------------------------------------
// Against the tree on 2026-09-07, AFTER the addresses were centralised:
//   1333 files scanned under app/ + components/
//     13 email literals found, in 13 distinct files
//     12 of them stripped as input placeholders
//      0 violations
// The floors below sit under those numbers with headroom. They exist because
// centralising the addresses REMOVED them from app/ and components/ — the very
// corpus this fence scans — so without a floor the scan could quietly start
// matching nothing (a broken regex, a renamed root, an over-eager comment
// stripper) and stay green forever. The placeholder count is floored for the
// same reason: it proves the exemption branch is still being exercised rather
// than sitting dead.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PrivacidadPage from "@/app/(public)/privacidad/page";
import {
  CONTACT_EMAILS,
  OWNED_MAIL_DOMAINS,
  PRIMARY_MAIL_DOMAIN,
  mailtoHref,
} from "@/lib/ui/contact";

// RFC 2606 §3 reserves these second-level names for documentation and examples.
// They are guaranteed never to resolve, which is what makes them safe to print
// and useless to a would-be correspondent.
const RESERVED_EXAMPLE_DOMAINS = ["example.com", "example.net", "example.org"];

/** Shipped surfaces a citizen or funcionario can actually read. */
const ROOTS = ["app", "components"];

/**
 * Strip comments so an address discussed in prose is not read as shipped copy.
 * Same detector as __tests__/no-personal-contact-in-ui.test.ts.
 */
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

/** Strip `placeholder="…"`, `placeholder={"…"}` and `placeholder={`…`}`. */
const PLACEHOLDER_ATTR = /placeholder=\{?\s*(["'`])[\s\S]*?\1\s*\}?/g;

function stripPlaceholders(source: string): string {
  return source.replace(PLACEHOLDER_ATTR, "");
}

const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

function addressesIn(source: string): string[] {
  return [...source.matchAll(EMAIL)].map((m) => m[0]);
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** True when mail sent to this address can actually be received by us. */
function isOwned(address: string): boolean {
  return (OWNED_MAIL_DOMAINS as readonly string[]).includes(domainOf(address));
}

/** The rule, as one function, so the controls below exercise the real thing. */
function unreachableAddressesIn(source: string): string[] {
  const shipped = stripPlaceholders(stripComments(source));
  return addressesIn(shipped).filter(
    (a) => !isOwned(a) && !RESERVED_EXAMPLE_DOMAINS.includes(domainOf(a)),
  );
}

function collectUiFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    const dir = entry.parentPath ?? entry.path ?? root;
    if (dir.includes("node_modules")) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

const UI_FILES = ROOTS.flatMap(collectUiFiles);

const SCAN = UI_FILES.map((file) => {
  const source = readFileSync(file, "utf8");
  const commentless = stripComments(source);
  const all = addressesIn(commentless);
  const shipped = addressesIn(stripPlaceholders(commentless));
  return {
    file: file.replace(/\\/g, "/"),
    all,
    strippedAsPlaceholder: all.length - shipped.length,
    unreachable: unreachableAddressesIn(source),
  };
});

describe("the mailboxes miMAR publishes are at domains miMAR owns", () => {
  it("the allowlist is short, lowercase and non-empty", () => {
    // A domain list nobody can read is a domain list nobody reviews. If this
    // ever needs more than a handful of entries, the product has a naming
    // problem, not a fence problem.
    expect(OWNED_MAIL_DOMAINS.length).toBeGreaterThan(0);
    expect(OWNED_MAIL_DOMAINS.length).toBeLessThanOrEqual(4);
    for (const d of OWNED_MAIL_DOMAINS) {
      expect(d, "an owned domain must be a bare lowercase hostname").toMatch(
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
      );
    }
    expect(OWNED_MAIL_DOMAINS).toContain(PRIMARY_MAIL_DOMAIN);
  });

  it("every published address is at an owned domain", () => {
    // The constants themselves. `mimar.ar` — no NS, no MX on two resolvers —
    // is what this catches if anyone reintroduces it.
    for (const [name, address] of Object.entries(CONTACT_EMAILS)) {
      expect(
        isOwned(address),
        `CONTACT_EMAILS.${name} = ${address} is not at an owned domain`,
      ).toBe(true);
    }
  });
});

describe("the fence scans a real corpus (non-vacuity floors)", () => {
  // Measured 2026-09-07: 1333 files, 13 literals in 13 files, 12 placeholders.
  it("scans the shipped surfaces — at least 1000 files", () => {
    expect(UI_FILES.length).toBeGreaterThanOrEqual(1000);
  });

  it("still finds email literals to classify — at least 8, in at least 8 files", () => {
    const literals = SCAN.reduce((n, s) => n + s.all.length, 0);
    const files = SCAN.filter((s) => s.all.length > 0).length;
    expect(
      literals,
      "the address extractor matched nothing — regex or roots broken",
    ).toBeGreaterThanOrEqual(8);
    expect(files).toBeGreaterThanOrEqual(8);
  });

  it("the placeholder exemption is still being exercised — at least 8 stripped", () => {
    const stripped = SCAN.reduce((n, s) => n + s.strippedAsPlaceholder, 0);
    expect(stripped).toBeGreaterThanOrEqual(8);
  });
});

describe("the fence catches what it claims to catch (controls)", () => {
  it("flags the dead domain this bug shipped", () => {
    expect(unreachableAddressesIn('<a href="mailto:hola@mimar.ar">escribinos</a>')).toEqual([
      "hola@mimar.ar",
    ]);
  });

  it("flags a domain nobody has typed yet — the point of banning the class", () => {
    // mimar.gob.ar is the plausible NEXT address: it is the eventual government
    // origin and is not delegated. A blocklist of "mimar.ar" would wave it
    // through; an allowlist of what we own does not.
    expect(unreachableAddressesIn('const to = "prensa@mimar.gob.ar";')).toEqual([
      "prensa@mimar.gob.ar",
    ]);
    expect(unreachableAddressesIn('const to = "soporte@mimra.com.ar";')).toEqual([
      "soporte@mimra.com.ar",
    ]);
  });

  it("does not flag an owned address, a placeholder, or an RFC 2606 example", () => {
    expect(unreachableAddressesIn(`const to = "${CONTACT_EMAILS.privacy}";`)).toEqual([]);
    expect(unreachableAddressesIn('<input placeholder="vos@ejemplo.com" />')).toEqual([]);
    expect(unreachableAddressesIn('inviteeEmail: "invitee@example.com",')).toEqual([]);
  });

  it("does not let a comment hide an address, nor a comment create one", () => {
    // Comment stripping must not swallow executable code on the same run: a
    // fence that finds nothing because it looks at nothing passes forever.
    expect(
      unreachableAddressesIn(
        ["// contacto: viejo@mimar.ar", 'const to = "hola@mimar.ar";'].join("\n"),
      ),
    ).toEqual(["hola@mimar.ar"]);
  });

  it("a contact address moved out of a placeholder is caught", () => {
    // The exemption is structural, not an escape hatch: the same literal that
    // passes inside `placeholder` fails the moment it becomes a link.
    expect(unreachableAddressesIn('<input placeholder="hola@mimar.ar" />')).toEqual([]);
    expect(unreachableAddressesIn('<a href="mailto:hola@mimar.ar">x</a>')).toEqual([
      "hola@mimar.ar",
    ]);
  });
});

describe("no shipped page or component names an address we cannot receive mail at", () => {
  it("app/ and components/ are clean", () => {
    const offenders = SCAN.filter((s) => s.unreachable.length > 0).map(
      (s) => `${s.file} (${s.unreachable.join(", ")})`,
    );
    expect(
      offenders,
      [
        "These files SHIP to citizens and funcionarios and name an email address at a",
        "domain this project does not own, so mail sent there does not arrive.",
        "",
        "Do not retype an address. Import it:",
        "  import { CONTACT_EMAILS, mailtoHref } from '@/lib/ui/contact';",
        `  CONTACT_EMAILS.general  (${CONTACT_EMAILS.general})`,
        `  CONTACT_EMAILS.privacy  (${CONTACT_EMAILS.privacy})`,
        "",
        "If a genuinely new domain is now owned, add it to OWNED_MAIL_DOMAINS in",
        "lib/ui/contact.ts — but only once it resolves AND has MX. An aspirational",
        "entry does not widen the allowlist, it disarms this check.",
      ].join("\n"),
    ).toEqual([]);
  });
});

describe("mailtoHref", () => {
  it("percent-encodes subject and body so call sites stop hand-rolling it", () => {
    // Byte-identical to the escape the four call sites used to hardcode.
    expect(mailtoHref(CONTACT_EMAILS.general, { subject: "miMAR — Acceso a analytics" })).toBe(
      `mailto:${CONTACT_EMAILS.general}?subject=miMAR%20%E2%80%94%20Acceso%20a%20analytics`,
    );
    expect(
      mailtoHref(CONTACT_EMAILS.general, {
        subject: "miMAR — Agregar localidad",
        body: "Localidad: Bahía Blanca",
      }),
    ).toBe(
      `mailto:${CONTACT_EMAILS.general}?subject=miMAR%20%E2%80%94%20Agregar%20localidad&body=Localidad%3A%20Bah%C3%ADa%20Blanca`,
    );
  });

  it("emits no query string when there is nothing to carry", () => {
    expect(mailtoHref(CONTACT_EMAILS.privacy)).toBe(`mailto:${CONTACT_EMAILS.privacy}`);
  });
});

describe("/privacidad — the Ley 25.326 rights channel actually reaches someone", () => {
  it("renders a mailto at an owned domain, labelled with the same address", () => {
    // The rendered page, not the source: this is the surface a person who has
    // been locked out of their account has to use to demand access or erasure,
    // and it is the reason this whole change exists. A link whose visible text
    // disagrees with its href is its own defect — a reader who copies the label
    // into their own mail client must land in the same inbox as a click.
    const { container } = render(<PrivacidadPage />);
    const mailtos = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="mailto:"]')];

    expect(mailtos.length, "/privacidad publishes no contact channel at all").toBeGreaterThan(0);
    for (const a of mailtos) {
      const target = a.getAttribute("href")?.slice("mailto:".length).split("?")[0] ?? "";
      expect(isOwned(target), `/privacidad links to ${target}, a domain we do not own`).toBe(true);
      expect(a.textContent?.trim()).toBe(target);
    }
    expect(mailtos.some((a) => a.getAttribute("href") === `mailto:${CONTACT_EMAILS.privacy}`)).toBe(
      true,
    );
  });
});
