// Doc-drift fence for the event catalog count.
//
// `EVENT_TYPES` (db/schema.ts) is the single source of truth for how many
// event types exist. Several human-facing docs restate that number in prose
// ("Event catalog — 48 types"). Those numbers drift silently every time the
// catalog grows or shrinks — the git history shows the AGENTS.md heading
// lagging reality at 23, 39, 45, and 47 across past cleanups.
//
// This fence derives the real count from EVENT_TYPES.length and asserts that
// every LIVE doc that states a catalog count agrees with it. Archived plans
// under docs/**/archive/** legitimately quote historical counts and are NOT
// scanned — only the curated set of currently-authoritative docs below.
//
// ANCHOR NOTE: the AGENTS.md heading `## Event catalog — N types` generates a
// GitHub slug `#event-catalog--N-types`. AGENTS.md and CLAUDE.md both link to
// that slug. If the count ever changes, the heading, the slug, and every link
// to it move together — so this fence also checks that the linked anchors match
// the derived slug. When it fails on a real catalog change, update BOTH the
// stated number AND the anchor links (or the cross-doc links go dead).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVENT_TYPES } from "@/db/schema";

const REPO_ROOT = join(__dirname, "..");

// Live, authoritative docs that restate the catalog count. Do NOT add archived
// plans/specs here — they quote historical counts on purpose.
const DOCS_WITH_COUNT = ["AGENTS.md", "CLAUDE.md", "docs/event-design-checklist.md"] as const;

// Matches "Event catalog — 48 types" and "Event catalog (48 types)" (the em-dash
// heading form and the parenthetical index form), capturing the stated number.
const COUNT_RE = /Event catalog\s*[—(]\s*(\d+)\s*types/g;

// Matches an anchor link to the event-catalog heading, e.g.
// (#event-catalog--48-types), capturing the number embedded in the slug.
const ANCHOR_RE = /#event-catalog--(\d+)-types/g;

describe("event catalog count parity", () => {
  const realCount = EVENT_TYPES.length;

  it("EVENT_TYPES is the source of truth (sanity)", () => {
    expect(realCount).toBeGreaterThan(0);
  });

  for (const rel of DOCS_WITH_COUNT) {
    it(`${rel} states the real catalog count (${realCount})`, () => {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");

      const stated = [...text.matchAll(COUNT_RE)].map((m) => Number(m[1]));
      expect(
        stated.length,
        `${rel} states no "Event catalog — N types" count. If you removed the phrasing, drop this file from DOCS_WITH_COUNT in this fence.`,
      ).toBeGreaterThan(0);

      for (const n of stated) {
        expect(
          n,
          `${rel} says "Event catalog … ${n} types" but EVENT_TYPES has ` +
            `${realCount}. Update the doc (and the #event-catalog--N-types anchor ` +
            `if the heading number moved) to ${realCount}.`,
        ).toBe(realCount);
      }
    });
  }

  it("cross-doc anchor links match the derived heading slug", () => {
    for (const rel of DOCS_WITH_COUNT) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      for (const m of text.matchAll(ANCHOR_RE)) {
        const n = Number(m[1]);
        expect(
          n,
          `${rel} links to "#event-catalog--${n}-types" but the heading slug is "#event-catalog--${realCount}-types". Update the anchor to keep the cross-doc link alive.`,
        ).toBe(realCount);
      }
    }
  });
});
