// Landing honesty fitness test — the marketing copy stops overclaiming.
//
// WHY THIS EXISTS (WU1, landing redesign 2026-09-24, orchestrator-reviewed
// plan dim-interno:docs/design/handoffs/2026-09-24-landing-redesign-plan.md)
// ---------------------------------------------------------------------------
// The home page shipped several claims the product cannot back, catalogued in
// dim-interno:docs/presentation/2026-09-oficiales/limites-honestos.md §A.1:
// "Es un registro inmutable: nadie puede alterar el historial" does not
// survive contact with art. 16 de la Ley 25.326, which requires an AUDITED
// SUPPRESSION EXCEPTION over the event log — a system that must be able to
// comply with a subject-rights erasure request cannot also be inmutable, and
// that is the correct design, not a defect. "El registro nacional de
// mascotas" implies a state-run registry that does not exist (see
// __tests__/state-endorsement-fence.test.ts, which polices the narrower class
// of NAMED state-body claims — this file is the honesty pass around it: no
// state body is named, but "nacional" still reads as official). And the
// panorama choropleth the "Estado" chapter shows is served from
// panorama_cube, which refreshes once a day (vercel.json cron "0 3 * * *",
// see app/api/cron/refresh-cube and
// src/modules/panorama/domain/cube-freshness.ts) — "en tiempo real" is false
// for that surface.
//
// This is a DIFFERENT concern from state-endorsement-fence.test.ts (which
// polices claims of Argentine STATE backing) and is not the natural home for
// it: these terms are about overclaiming the PRODUCT's own capabilities —
// permanence, national reach, live data, licensing — independent of who runs
// it. A single sentence can fail this fence while naming no state body at
// all ("historial inmutable"), and a sentence can pass the state-body fence
// while failing this one ("el registro nacional de mascotas" — "nacional"
// alone is not a STATE_BODY match there). Kept separate rather than merged so
// neither fence's exemptions (norm citations, pending markers) leak into a
// class of claim they were never designed for.
//
// CORRECTED 2026-09-24 (fresh review): this fence's OWN first draft blessed
// "nada se reescribe" as an honest replacement for "inmutable" — it is not.
// Límites honestos A.1 documents an AUDITED SUPPRESSION EXCEPTION (art. 16
// Ley 25.326), and /privacidad documents that account erasure replaces the
// user's free text with a notice — a rewrite. "Nada se reescribe" / "nunca se
// borra" / "nada se borra" all deny that exception exists, which is exactly
// the overclaim shape A.1 exists to catch. A.1's own wording — "una
// corrección es un asiento nuevo, nunca una edición" — describes the
// append-only DEFAULT without denying the exception, so it is what "inmutable"
// gets replaced with instead.
//
// SCOPE — narrower than state-endorsement-fence.test.ts on purpose: only the
// landing itself and its `/municipios` door (WU4), not the whole citizen
// corpus. `/acerca` still says "inmutable" and "Autoridades sanitarias"
// today; that page is out of scope for WU1 and is not touched by this fence.
//
// Comments are stripped before scanning: this file, and the notes left beside
// each removal, quote the banned copy on purpose (same rationale as
// state-endorsement-fence.test.ts — an instrument that reads prose ABOUT the
// defect is measuring the documentation, not the code).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
 * Each term is a distinct overclaim, cited against límites honestos A.1 (the
 * append-only/"inmutable" claim) or the plan's WU1 table (national reach,
 * live-data cadence, licensing). No exemptions, unlike the state-endorsement
 * fence: none of these five phrases has a legitimate honest use on the
 * landing or on /municipios — a norm citation never needs the word
 * "inmutable", and there is no "próximamente, en tiempo real" phrasing that
 * would make the claim true today.
 */
const BANNED_TERMS: Array<{ re: RegExp; label: string }> = [
  { re: /\binmutabl\w*/gi, label: "inmutable (límites honestos A.1 — art. 16 Ley 25.326)" },
  { re: /\bregistro\s+nacional\b/gi, label: "registro nacional (implies a state-run registry)" },
  { re: /\bMinisterio\b/gi, label: "Ministerio (implies state operation)" },
  {
    re: /\ben\s+tiempo\s+real\b/gi,
    label: "en tiempo real (panorama_cube refreshes once a day, not live)",
  },
  {
    re: /\bc[oó]digo\s+abierto\b|\bopen[\s-]source\b/gi,
    label: "código abierto / open source (LICENSE is proprietary — inspection/audit only)",
  },
  {
    re: /\bnada\s+se\s+reescribe\b/gi,
    label: "nada se reescribe (denies the A.1 audited suppression exception)",
  },
  {
    re: /\bnunca\s+se\s+borra\b/gi,
    label: "nunca se borra (denies the A.1 audited suppression exception)",
  },
  {
    re: /\bnada\s+se\s+borra\b/gi,
    label: "nada se borra (denies the A.1 audited suppression exception)",
  },
];

const ROOTS = ["components/landing", "app/(public)/municipios"];

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

const FILES = ROOTS.flatMap(collect);

type Violation = { file: string; label: string; match: string };

function violationsIn(source: string): Array<{ label: string; match: string }> {
  const prose = stripComments(source);
  const out: Array<{ label: string; match: string }> = [];
  for (const { re, label } of BANNED_TERMS) {
    for (const m of prose.matchAll(re)) {
      out.push({ label, match: m[0] });
    }
  }
  return out;
}

const SCAN: Violation[] = FILES.flatMap((file) => {
  const source = readFileSync(file, "utf8");
  const rel = file.replace(/\\/g, "/");
  return violationsIn(source).map((v) => ({ file: rel, ...v }));
});

describe("landing copy does not overclaim (WU1 honesty pass)", () => {
  it("bans inmutable / registro nacional / Ministerio / en tiempo real / código abierto·open source / nada se reescribe·borra / nunca se borra", () => {
    expect(
      SCAN,
      `overclaiming copy found on the landing or /municipios:\n${SCAN.map(
        (v) => `  • ${v.file}: [${v.match}] ${v.label}`,
      ).join("\n")}`,
    ).toEqual([]);
  });
});

describe("the fence is not vacuous", () => {
  it("scans the landing + /municipios corpus (guards against a renamed/emptied root)", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(15);
  });

  // Hand-written literals, never derived from the files under test: a fixture
  // read out of the corpus would pass whatever the corpus happens to say.
  it("FLAGS the exact copy that shipped before this fence — one probe per term", () => {
    expect(violationsIn("<p>…y toda su historia, inmutable.</p>")).not.toEqual([]);
    expect(
      violationsIn("<p>miMAR es el registro nacional de mascotas: una identidad pública.</p>"),
    ).not.toEqual([]);
    expect(violationsIn("<p>República Argentina · Ministerio de Salud</p>")).not.toEqual([]);
    expect(violationsIn("<p>la cobertura se mide en tiempo real.</p>")).not.toEqual([]);
    expect(violationsIn("<p>Repositorio de código abierto.</p>")).not.toEqual([]);
    expect(violationsIn("<p>This project is open source.</p>")).not.toEqual([]);
    // Corrected 2026-09-24 (fresh review): the fence's own FIRST draft
    // blessed this phrase — see the PASSES probe below, which no longer does.
    expect(violationsIn("<p>Su historial solo se agrega: nada se reescribe.</p>")).not.toEqual([]);
    expect(violationsIn("<p>…y toda su historia, nunca se borra.</p>")).not.toEqual([]);
    expect(violationsIn("<p>La línea de vida es de Pampa: nada se borra.</p>")).not.toEqual([]);
  });

  it("PASSES the honest replacements this WU shipped", () => {
    expect(
      violationsIn(
        "<p>Su historial solo se agrega: una corrección es un asiento nuevo, nunca una edición.</p>",
      ),
    ).toEqual([]);
    expect(
      violationsIn(
        "<p>La libreta sanitaria de tu mascota en el teléfono, con una credencial QR.</p>",
      ),
    ).toEqual([]);
    expect(violationsIn("<p>…y toda su historia, asiento por asiento.</p>")).toEqual([]);
    expect(violationsIn("<p>La cobertura se actualiza sola, sin planillas.</p>")).toEqual([]);
  });
});
