// Guard for the vet/refugio-get-a-tablet redesign (PO 2026-09-29): the device
// a chapter renders tells the viewer who is using the system — Martín's own
// phone everywhere he is the actor, a landscape tablet running the
// organization's web portal wherever a vet or a refugio is. Neither frame
// takes a size-variant prop (same rule for both, so no chapter can quietly
// grow or shrink its own device).
//
// Rendering strategy mirrors the repo's other structure tests: components →
// react-dom/server static HTML, no jsdom (see flagship-pampa-consistency.test.tsx,
// landing-structure.test.tsx).

import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children?: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import { PhoneFrame } from "@/components/landing/PhoneFrame";
import { StorySection } from "@/components/landing/StorySection";
import { TabletFrame } from "@/components/landing/TabletFrame";
import {
  LOST_SEQUENCE,
  OWNER_FROM,
  SHELTER_SEQUENCE,
  VET_SEQUENCE,
} from "@/components/landing/story-sequences";

/** The rendered slice for one chapter's `id="cap-<key>"` block. */
function chapterHtml(html: string, key: string): string {
  const marker = `id="cap-${key}"`;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`chapter "${key}" not found in rendered StorySection`);
  const next = html.indexOf('id="cap-', start + marker.length);
  return html.slice(start, next === -1 ? html.length : next);
}

describe("landing story — the device tells who is using it (PO 2026-09-29)", () => {
  it("PhoneFrame and TabletFrame declare no size-variant props — one fixed size each", () => {
    for (const file of [
      "components/landing/PhoneFrame.tsx",
      "components/landing/TabletFrame.tsx",
    ]) {
      const source = readFileSync(file, "utf8");
      // The component signature is `{ children }: { children: ReactNode }` —
      // no second prop of any name.
      expect(source, file).toMatch(/\{\s*children\s*\}:\s*\{\s*children:\s*ReactNode\s*\}/);
    }
  });

  it("the owner chapters (dueno, libreta) render PhoneFrame, never TabletFrame", () => {
    const html = renderToStaticMarkup(<StorySection />);
    for (const key of ["dueno", "libreta"]) {
      const segment = chapterHtml(html, key);
      expect(segment, key).toContain("lp-phone");
      expect(segment, key).not.toContain("lp-tablet");
    }
  });

  it("the vet chapter renders TabletFrame at every step, never PhoneFrame", () => {
    for (let i = 0; i < VET_SEQUENCE.total; i++) {
      const html = renderToStaticMarkup(VET_SEQUENCE.device(i, false));
      expect(html, `step ${i}`).toContain("lp-tablet");
      expect(html, `step ${i}`).not.toContain("lp-phone");
    }
  });

  // Chapter 3 is two people's phones (PO 2026-10-01): the owner's, the
  // neighbour's, the owner's again — phones all, never a tablet.
  it("the lost chapter (anon) stays on phones throughout, never a tablet", () => {
    for (let i = 0; i < LOST_SEQUENCE.total; i++) {
      const html = renderToStaticMarkup(LOST_SEQUENCE.device(i, false));
      expect(html, `step ${i}`).toContain("lp-phone");
      expect(html, `step ${i}`).not.toContain("lp-tablet");
    }
  });

  it("the refugio chapter renders TabletFrame for the shelter's own steps, then PhoneFrame once the owner takes over", () => {
    for (let i = 0; i < SHELTER_SEQUENCE.total; i++) {
      const html = renderToStaticMarkup(SHELTER_SEQUENCE.device(i, false));
      if (i < OWNER_FROM) {
        expect(html, `step ${i}`).toContain("lp-tablet");
        expect(html, `step ${i}`).not.toContain("lp-phone");
      } else {
        expect(html, `step ${i}`).toContain("lp-phone");
        expect(html, `step ${i}`).not.toContain("lp-tablet");
      }
    }
  });
});

// One tablet for both organizations, drawn as a real device (PO 2026-09-30):
// the vet and the refugio render the SAME frame — same component, same
// geometry, same bezel — and only the case colour (data-actor → --lp-case)
// differs. The chrome is decorative: aria-hidden, and no text node at all, so
// the in-device product-string fence (flagship-pampa-consistency) never sees
// a string the product does not render.
describe("landing story — device chrome (PO 2026-09-30)", () => {
  /** The device with its screen content cut out: case wrapper + frame chrome only. */
  function frameSkeleton(html: string): string {
    const open = '<div class="lp-tab-scr">';
    const start = html.indexOf(open);
    const end = html.indexOf('<span class="lp-tablet-edge">');
    if (start === -1 || end === -1) throw new Error("tablet screen not found");
    return html.slice(0, start + open.length) + html.slice(end);
  }

  it("the vet and the refugio render the identical tablet, differing only by case colour", () => {
    const vetFrames = Array.from({ length: VET_SEQUENCE.total }, (_, i) =>
      frameSkeleton(renderToStaticMarkup(VET_SEQUENCE.device(i, false))),
    );
    const shelterFrames = Array.from({ length: OWNER_FROM }, (_, i) =>
      frameSkeleton(renderToStaticMarkup(SHELTER_SEQUENCE.device(i, false))),
    );
    for (const f of vetFrames) expect(f).toContain('data-actor="vet"');
    for (const f of shelterFrames) expect(f).toContain('data-actor="shelter"');
    const normalise = (f: string) => f.replace(/data-actor="(vet|shelter)"/, 'data-actor="*"');
    const reference = normalise(vetFrames[0] ?? "");
    expect(reference).toContain('<div class="lp-tablet" aria-hidden="true">');
    for (const f of [...vetFrames, ...shelterFrames]) expect(normalise(f)).toBe(reference);
  });

  it("no per-actor CSS rule reshapes a device: data-actor only sets the case colour", () => {
    // Comments stripped first: prose mentioning data-actor is not a rule.
    const css = readFileSync("app/landing.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = css.match(/[^{}]*data-actor[^{}]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(4);
    for (const rule of rules) {
      const body = rule.slice(rule.indexOf("{") + 1, rule.lastIndexOf("}"));
      const props = body
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => d.slice(0, d.indexOf(":")).trim());
      expect(props, rule.trim()).toEqual(["--lp-case"]);
    }
  });

  it("phone and tablet chrome is aria-hidden and adds no text", () => {
    for (const html of [
      renderToStaticMarkup(<PhoneFrame>{null}</PhoneFrame>),
      renderToStaticMarkup(<TabletFrame>{null}</TabletFrame>),
    ]) {
      expect(html).toMatch(/^<div class="lp-(phone|tablet)" aria-hidden="true">/);
      // Every tag stripped leaves nothing: no clock, no carrier, no label.
      expect(html.replace(/<[^>]*>/g, "").trim()).toBe("");
      expect(html).not.toMatch(/<(text|title|desc)\b/);
    }
    const phone = renderToStaticMarkup(<PhoneFrame>{null}</PhoneFrame>);
    // The camera island and the side keys stay.
    for (const part of [
      "lp-phone-bezel",
      "lp-phone-island",
      "lp-phone-key--vol-up",
      "lp-phone-key--vol-down",
      "lp-phone-key--power",
    ]) {
      expect(phone).toContain(part);
    }
    // No status bar (PO 2026-10-01): the signal / wifi / battery glyphs are
    // gone, and with them the frame's only SVG.
    expect(phone).not.toContain("lp-phone-status");
    expect(phone).not.toContain("<svg");
    const css = readFileSync("app/landing.css", "utf8");
    expect(css).not.toContain("lp-phone-status");
  });
});
