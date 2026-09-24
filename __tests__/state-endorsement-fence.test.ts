// Nothing miMAR shows a citizen may claim the Argentine State stands behind it.
//
// WHY THIS EXISTS (measured 2026-09-11)
// ---------------------------------------------------------------------------
// The public landing page opened with an eyebrow reading "República Argentina ·
// Ministerio de Salud", directly above the headline. Its footer's legal line
// read "Ministerio de Salud · República Argentina" followed by the ministry's
// own domain. The FAQ trust row said "Operado por la autoridad sanitaria
// nacional" and the FAQ answer said "miMAR lo opera la autoridad sanitaria
// nacional". The phone app printed "REPÚBLICA ARGENTINA" in the slot a
// credential reserves for its ISSUING AUTHORITY — the stylesheet key was
// literally `footAuthority` — on the screen a funcionario is asked to accept as
// identification. The open-data license stamped `datos.mimar.gob.ar` onto every
// dataset download.
//
// NONE OF IT WAS TRUE. There is no convenio with any state body. The Mi
// Argentina agreement — the federation this whole architecture is premised on —
// is still listed as an open, unstarted prerequisite in
// dim-interno:docs/design/sdd/2026-07-07-miargentina-federation.md, and `mimar.gob.ar` is
// deliberately absent from OWNED_WEB_DOMAINS in lib/infra/site-url.ts "until it
// is delegated". Two costs: Play treats implied government affiliation as
// impersonation, and a funcionario who opens the site and finds their own
// ministry's name on a page nobody authorised stops evaluating the product.
//
// WHAT THIS FENCE BANS, AND WHY IT IS NOT A LIST OF STRINGS
// ---------------------------------------------------------------------------
// Banning "Ministerio de Salud" passes the day someone writes "Ministerio de
// Agricultura", or "SENASA", or "Presidencia de la Nación". This repo has paid
// for enumerating spellings before (docs: "a fence that enumerates forms misses
// one"). So the subject is the CLASS: a citizen-facing file may not NAME an
// Argentine state body at all — unless the naming is structurally something
// other than a claim.
//
// THE TWO EXEMPTIONS, AND WHY THEY CANNOT BE USED TO SMUGGLE A CLAIM
// ---------------------------------------------------------------------------
// 1. A NORM CITATION. "Ley 25.326 ... de la República Argentina" names the
//    State because that is whose law it is; "Res. SENASA 284/2024" names SENASA
//    because SENASA wrote the resolution. Citing a norm is true of anyone who
//    complies with it and claims nothing about who backs the product. So a
//    sentence naming a body passes when the SAME sentence carries a norm
//    reference (Ley / Decreto / Resolución / Disposición / Ordenanza + number).
//
// 2. AN EXPLICIT STATEMENT THAT IT DOES NOT EXIST YET. "Conectar con Mi
//    Argentina (próximamente)" and "está diseñado para integrarse en el futuro
//    con Mi Argentina" are the OPPOSITE of an endorsement claim — they tell the
//    reader the relationship is absent. A sentence passes when it carries a
//    pending marker (próximamente / en el futuro / en desarrollo / todavía no /
//    aún no), or the independence disclaimer itself ("no es un sitio oficial
//    del Estado argentino" names the State in order to DENY the relationship,
//    which is the sentence this whole fence exists to protect).
//
// Neither exemption launders a claim. "Operado por el Ministerio de Salud" has
// no norm number and no pending marker, so it fails; adding "próximamente" to
// it would make the sentence honest, which is the point.
//
// Full `https://…` URLs are stripped before the name scan: linking a citizen
// OUT to argentina.gob.ar/salud for rabies information is a source reference,
// not a claim of partnership. What is banned instead is (a) a `.gob.ar` host
// written as BARE TEXT — the landing footer's "argentina.gob.ar/salud" sat
// under the ministry's name as if it were ours — and (b) any `.gob.ar` host
// carrying this project's own name, which asserts a state delegation nobody has
// granted.
//
// Comments are stripped: this file, and the notes left beside each removal,
// quote the banned copy on purpose.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OPEN_DATA_LICENSE } from "@/lib/open-data/datasets";

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/**
 * Names of Argentine state bodies, and the generic forms that stand in for one.
 * Deliberately open-ended where it can be: `Ministerio de X` matches a ministry
 * nobody has typed yet.
 */
const STATE_BODY =
  /\bMinisterio\s+de\s+[A-ZÁÉÍÓÚÑ]\w*|\bSENASA\b|\bRENAPER\b|\bANMAT\b|\bAAIP\b|\bSNVS\b|\bINDEC\b|\bRep[úu]blica\s+Argentina\b|\bMi\s+Argentina\b|\bPresidencia\s+de\s+la\s+Naci[óo]n\b|\bGobierno\s+(?:Nacional|de\s+la\s+Naci[óo]n)\b|\bEstado\s+(?:Nacional|argentino)\b|\bautoridad\s+sanitaria\s+nacional\b/gi;

/** A norm reference: the kind of instrument, then its number. */
const NORM_CITATION =
  /\b(?:Ley(?:es)?|Decreto|Decr|Resoluci[óo]n|Res|Disposici[óo]n|Disp|Ordenanza)\.?\s+(?:\S+\s+){0,2}\d[\d./-]*/i;

/** An explicit statement that the relationship does not exist yet. */
const PENDING_MARKER =
  /pr[óo]ximamente|en\s+el\s+futuro|en\s+desarrollo|todav[íi]a\s+no|a[úu]n\s+no|no\s+es\s+un\s+sitio\s+oficial|servicio\s+independiente/i;

/** A `.gob.ar` host written as bare text rather than inside a full URL. */
const GOB_AR_HOST = /\b[a-z0-9][a-z0-9.-]*\.gob\.ar\b/gi;

/** This project's own names — a `.gob.ar` host carrying one claims delegation. */
const OUR_NAME = /\b(?:mimar|dim)\b/i;

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

/**
 * Reduce source to the prose a reader sees: drop full URLs (an outward source
 * reference is not a claim), drop JSX tags and whitespace-only expressions so a
 * sentence split across `<strong>` and `{" "}` stays one sentence.
 */
function toProse(source: string): string {
  return stripComments(source)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\{\s*["'`]\s*["'`]\s*\}/g, " ")
    .replace(/[ \t]+/g, " ");
}

/** Split on sentence boundaries. `.` only counts when whitespace follows, so a
 *  norm number like "Ley 25.326" is never cut in half. */
const NORM_ABBREV = /\b(Res|Decr|Disp|Art|Inc|Ref)\./gi;

function sentencesIn(prose: string): string[] {
  // "Res. SENASA 284/2024" must survive as ONE sentence, or the citation is
  // torn off the body it cites and SENASA reads as an unexplained naming. The
  // period inside a norm NUMBER ("Ley 25.326") is already safe — nothing
  // follows it but a digit — so only the abbreviations need unpunctuating.
  return prose.replace(NORM_ABBREV, "$1").split(/[\n;!?]+|\.\s|\.$/);
}

type Violation = { sentence: string; named: string };

/** The rule, as one function, so the controls below exercise the real thing. */
function violationsIn(source: string): Violation[] {
  const out: Violation[] = [];

  for (const sentence of sentencesIn(toProse(source))) {
    const named = [...sentence.matchAll(STATE_BODY)].map((m) => m[0]);
    if (named.length === 0) continue;
    if (NORM_CITATION.test(sentence)) continue;
    if (PENDING_MARKER.test(sentence)) continue;
    out.push({ sentence: sentence.trim().slice(0, 160), named: named.join(", ") });
  }

  for (const [host] of stripComments(source).matchAll(GOB_AR_HOST)) {
    // Inside a full URL it was already stripped by toProse; reaching here means
    // it is bare text, OR it carries our own name (banned either way).
    const bare = toProse(source).includes(host);
    if (bare || OUR_NAME.test(host)) {
      out.push({ sentence: host, named: host });
    }
  }

  return out;
}

/** Every occurrence a citizen-facing file names, exempt or not. Non-vacuity. */
function namedBodiesIn(source: string): string[] {
  return [...toProse(source).matchAll(STATE_BODY)].map((m) => m[0]);
}

// ---------------------------------------------------------------------------
// The corpus: what a person sees before logging in, plus the phone app
// ---------------------------------------------------------------------------

const ROOTS = [
  "app/(public)",
  "app/(auth)",
  "components/landing",
  "components/layout",
  "apps/mobile/src",
];

const EXTRA_FILES = ["app/layout.tsx", "app/manifest.ts", "lib/open-data/datasets.ts"];

function collect(root: string): string[] {
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

const FILES = [...ROOTS.flatMap(collect), ...EXTRA_FILES];

const SCAN = FILES.map((file) => {
  const source = readFileSync(file, "utf8");
  return {
    file: file.replace(/\\/g, "/"),
    named: namedBodiesIn(source),
    violations: violationsIn(source),
  };
});

// ---------------------------------------------------------------------------

describe("no citizen-facing copy claims the Argentine State backs miMAR", () => {
  it("names no state body outside a norm citation or a stated-pending integration", () => {
    const offenders = SCAN.filter((s) => s.violations.length > 0).map(
      (s) =>
        `${s.file}\n    ${s.violations.map((v) => `[${v.named}] ${v.sentence}`).join("\n    ")}`,
    );
    expect(
      offenders,
      `a citizen-facing file names a state body as if it backed miMAR:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("publishes no .gob.ar host of its own — that domain is not delegated", () => {
    // lib/infra/site-url.ts keeps `mimar.gob.ar` out of OWNED_WEB_DOMAINS on
    // purpose. The open-data attribution is stamped into every download and
    // into every citation made from one, so it is the copy most likely to
    // outlive a correction.
    expect(OPEN_DATA_LICENSE.attribution).not.toMatch(/gob\.ar/i);
    expect(OPEN_DATA_LICENSE.attribution).toContain("miMAR");
  });
});

describe("the disclaimers that replaced the claims are actually shipped", () => {
  // PRESENCE, pinned against literals. An absence-only fence goes green the day
  // the footer is deleted, which is not the outcome anyone wanted.
  const DISCLAIMER = "no es un sitio oficial del Estado argentino";

  it("the landing footer states that miMAR is not a state site", () => {
    const source = readFileSync("components/landing/LandingFooter.tsx", "utf8");
    expect(stripComments(source)).toContain(DISCLAIMER);
  });

  it("the app footer states that miMAR is not a state site", () => {
    const source = readFileSync("components/layout/AppFooter.tsx", "utf8");
    expect(stripComments(source)).toContain(DISCLAIMER);
  });

  it("the hero eyebrow describes the credential, not an endorsement", () => {
    const source = stripComments(readFileSync("components/landing/LandingHero.tsx", "utf8"));
    expect(source).toContain("Credencial digital · QR público verificable");
  });

  it("the phone credential's foot names no issuing authority", () => {
    const source = stripComments(readFileSync("apps/mobile/src/pets/OwnerFace.tsx", "utf8"));
    expect(source).toContain("Libreta Sanitaria Nacional");
    expect(source).not.toMatch(/footAuthority/);
  });
});

describe("the fence is not vacuous", () => {
  // Measured 2026-09-11 against the tree this fence landed on: 253 files, 6
  // state-body namings found and classified — one Mi Argentina "próximamente"
  // on each auth form, one on /acerca, "República Argentina" qualifying Ley
  // 25.326 on /privacidad, and the two independence disclaimers. The floors
  // sit under those
  // numbers with headroom; they exist because the scan going quietly blind (a
  // broken regex, a renamed route group, an over-eager tag stripper) would look
  // exactly like a clean tree.
  it("scans the citizen-facing corpus — at least 180 files", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(180);
  });

  it("still finds state bodies to classify — at least 4, in at least 4 files", () => {
    const total = SCAN.reduce((n, s) => n + s.named.length, 0);
    const files = SCAN.filter((s) => s.named.length > 0).length;
    expect(
      total,
      "the state-body extractor matched nothing — regex or roots broken",
    ).toBeGreaterThanOrEqual(4);
    expect(files).toBeGreaterThanOrEqual(4);
  });

  // The controls below are hand-written literals, never derived from the files
  // under test: a fixture read out of the corpus would pass whatever the corpus
  // happens to say.
  it("FLAGS the exact copy that shipped — each of the five removals", () => {
    const reintroductions = [
      '<p className="lp-eyebrow">República Argentina · Ministerio de Salud</p>',
      "<span>Ministerio de Salud · República Argentina</span>",
      "<span>Operado por la autoridad sanitaria nacional</span>",
      '"Nada, nunca. miMAR lo opera la autoridad sanitaria nacional y recuperar a tu mascota no tiene costo."',
      "<Text style={styles.footAuthority}>República Argentina</Text>",
    ];
    for (const source of reintroductions) {
      expect(violationsIn(source), `not flagged: ${source}`).not.toEqual([]);
    }
  });

  it("FLAGS a ministry nobody has typed yet, and a fresh state host of ours", () => {
    expect(violationsIn("<p>Un programa del Ministerio de Agricultura</p>")).not.toEqual([]);
    expect(violationsIn("<span>argentina.gob.ar/salud</span>")).not.toEqual([]);
    expect(violationsIn('const base = "https://datos.mimar.gob.ar";')).not.toEqual([]);
  });

  it("PASSES a norm citation — naming the author of a law is not a claim", () => {
    expect(
      violationsIn(
        "<p>miMAR trata los datos conforme a la <strong>Ley 25.326</strong> de la República Argentina.</p>",
      ),
    ).toEqual([]);
    expect(violationsIn("<p>Chip ISO exigido por la Res. SENASA 284/2024.</p>")).toEqual([]);
  });

  it("PASSES a stated-pending integration — saying it does not exist is the opposite of a claim", () => {
    expect(violationsIn("<button>Conectar con Mi Argentina (próximamente)</button>")).toEqual([]);
    expect(
      violationsIn("<p>Está diseñado para integrarse en el futuro con Mi Argentina.</p>"),
    ).toEqual([]);
  });

  it("PASSES an outward link to a state source, and still flags the same host as bare text", () => {
    expect(
      violationsIn('<a href="https://www.argentina.gob.ar/salud/glosario/rabia">Rabia</a>'),
    ).toEqual([]);
    expect(violationsIn("<p>Más info en argentina.gob.ar/salud</p>")).not.toEqual([]);
  });
});
