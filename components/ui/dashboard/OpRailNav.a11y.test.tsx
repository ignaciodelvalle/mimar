// OpRailNav accessible-name fitness (a11y audit 2026-07).
//
// The gob/admin sidebar is the operator's primary navigation. Every link in it
// MUST expose a non-empty accessible name derived from its nav-presets label —
// an icon-only or truncated-to-nothing link would be unusable with a screen
// reader. This test renders the REAL GOB/ADMIN nav presets through OpRailNav
// (renderToStaticMarkup — repo convention, no jsdom) and fails if any anchor
// ends up unnamed, so a future visual compaction of the rail (icons, collapsed
// mode) cannot silently strip the names.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/gob",
  // P5 hover/focus prefetch (perf sweep 2026-08-02) calls useRouter().prefetch —
  // stub it so NavLink can render outside a real app-router context.
  useRouter: () => ({ prefetch: vi.fn() }),
}));

import { ADMIN_NAV_SECTIONS, GOB_NAV_SECTIONS } from "@/components/layout/nav-presets";
import { OpRailNav } from "@/components/ui/dashboard/OpRailNav";
import type { NavSection } from "@/components/ui/dashboard/OpRailNav";

/**
 * Extract [href, accessibleName] for every anchor in the markup. Accessible
 * name = aria-label when present, else the tag-stripped text content — the
 * same precedence a screen reader applies (aria-label wins over contents).
 */
function anchorNames(html: string): { href: string; name: string }[] {
  const out: { href: string; name: string }[] = [];
  const anchorRe = /<a\s([^>]*)>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(anchorRe)) {
    const attrs = m[1];
    const inner = m[2];
    // renderToStaticMarkup escapes & as &amp; inside attributes — decode so
    // hrefs with query strings compare equal to their nav-presets source.
    const href = (attrs.match(/href="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&");
    const ariaLabel = attrs.match(/aria-label="([^"]*)"/)?.[1];
    const text = inner
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ href, name: (ariaLabel ?? text).trim() });
  }
  return out;
}

function labelByHref(sections: NavSection[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sections) {
    for (const item of s.items) map.set(item.href, item.label);
  }
  return map;
}

describe("OpRailNav — every sidebar link has an accessible name (a11y fitness)", () => {
  for (const [portal, sections] of [
    ["gob", GOB_NAV_SECTIONS],
    ["admin", ADMIN_NAV_SECTIONS],
  ] as const) {
    it(`${portal}: every non-deferred nav link is named with its preset label`, () => {
      const html = renderToStaticMarkup(<OpRailNav sections={sections} variant="gob" />);
      const anchors = anchorNames(html);
      const labels = labelByHref(sections);

      // Every non-deferred preset item renders as an anchor…
      const deferredCount = sections.flatMap((s) => s.items).filter((i) => i.deferred).length;
      expect(anchors.length).toBe(labels.size - deferredCount);

      // …and every anchor's accessible name is exactly its preset label
      // (never empty, never icon-only silence).
      for (const a of anchors) {
        const expected = labels.get(a.href);
        expect(expected, `unknown nav href ${a.href}`).toBeTruthy();
        expect(a.name, `nav link ${a.href} has no accessible name`).not.toBe("");
        expect(a.name).toBe(expected);
      }
    });
  }

  it("a badge folds into the accessible name as prose, label first (WCAG 2.5.3)", () => {
    const sections: NavSection[] = [
      { label: "", items: [{ href: "/gob/cola", label: "Aprobaciones", badge: 3 }] },
    ];
    const html = renderToStaticMarkup(<OpRailNav sections={sections} variant="gob" />);
    const [anchor] = anchorNames(html);
    expect(anchor.name).toBe("Aprobaciones — 3 pendientes");
  });

  it("fails the fitness when a link would end up unnamed (empty label, no aria-label)", () => {
    const sections: NavSection[] = [{ label: "", items: [{ href: "/gob/x", label: "" }] }];
    const html = renderToStaticMarkup(<OpRailNav sections={sections} variant="gob" />);
    const [anchor] = anchorNames(html);
    // The extractor MUST see this as unnamed — this is the exact condition the
    // preset assertions above turn into a failure for real nav items.
    expect(anchor.name).toBe("");
  });
});
