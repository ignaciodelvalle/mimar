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

import { StorySection } from "@/components/landing/StorySection";
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

  // Chapter 3 is two people's phones (PO 2026-09-30): the neighbour's, then
  // the owner's — phones both, never a tablet.
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
