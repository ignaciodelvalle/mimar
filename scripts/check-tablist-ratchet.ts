// role="tablist" ratchet — tab semantics belong to the shared primitives.
//
// Accessible tabs are subtle: roving tabindex, arrow-key handling, aria-selected
// / aria-controls wiring, and focus management must all agree. That logic lives
// ONCE, in components/ui/Tabs.tsx and components/ui/UrlTabs.tsx. Every other
// hand-rolled `role="tablist"` is a place the a11y contract can (and historically
// did) drift. This fence bans NEW role="tablist" outside the two primitives; the
// three surfaces that predate them are grandfathered with an explicit baseline
// and should migrate to the primitives over time.
//
// Enforcement: ratchet with a per-file baseline (same shape as
// check-professionalism.ts). Comment lines are ignored — a `// … role="tablist"
// …` mention is documentation, not a control. Detection is the double-quoted JSX
// attribute form `role="tablist"`; a query-selector string like `[role='tablist']`
// (single quotes) is intentionally NOT matched.
//
// Run: pnpm tsx scripts/check-tablist-ratchet.ts
// Or:  pnpm lint:tablist
//
// Exits 1 with file:line on each new violation. Exits 0 if clean.

import { globSync, readFileSync } from "node:fs";

// The JSX attribute (double-quoted). Not the single-quoted selector form.
export const TABLIST_ATTR = /role="tablist"/g;

// The primitives that OWN tab semantics — unlimited, never flagged.
export const TABLIST_OWNER_FILES = new Set<string>([
  "components/ui/Tabs.tsx",
  "components/ui/UrlTabs.tsx",
]);

// Grandfathered surfaces predating the primitives, pinned at their current count.
// Migrating them to Tabs/UrlTabs lets these entries be removed. A count ABOVE the
// baseline (or any brand-new file) fails.
export const TABLIST_BASELINE: Record<string, number> = {
  "app/gob/maltrato/_inspector/WelfareInspectorContent.tsx": 1,
  // components/pet-profile/PetDetailTabsPanel.tsx left the baseline
  // (tarjeta-todo 2026-07-18): its hand-rolled tablist was removed for good —
  // the band turn button is the single flip control. Ratchet tightened so the
  // tablist cannot quietly return a THIRD time (history: removed by PO
  // decision #645, restored by the July redesign, removed again).
  "components/panorama/PanoramaDock.tsx": 1,
};

const FILES = globSync("{app,components}/**/*.tsx")
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !f.startsWith("node_modules/") && !f.includes("/node_modules/"));

/** Count real (non-comment) role="tablist" attribute occurrences in a file. */
export function countTablist(src: string): number {
  let count = 0;
  for (const rawLine of src.split(/\r?\n/)) {
    for (const match of rawLine.matchAll(TABLIST_ATTR)) {
      // Skip a match that sits inside a line comment or a JSDoc continuation.
      const commentIdx = rawLine.indexOf("//");
      if (commentIdx !== -1 && commentIdx < (match.index ?? 0)) continue;
      if (rawLine.trimStart().startsWith("*")) continue;
      count += 1;
    }
  }
  return count;
}

function runScan(): void {
  let hits = 0;
  let grandfathered = 0;
  let owned = 0;

  for (const relPath of FILES) {
    const src = readFileSync(relPath, "utf8");
    if (!src.includes('role="tablist"')) continue;
    const count = countTablist(src);
    if (count === 0) continue;

    if (TABLIST_OWNER_FILES.has(relPath)) {
      owned += count;
      continue;
    }
    const allowed = TABLIST_BASELINE[relPath] ?? 0;
    if (count > allowed) {
      console.error(
        `${relPath}: ${count} role="tablist" (baseline allows ${allowed}) — use the Tabs / UrlTabs primitive (components/ui) instead of a hand-rolled tablist so the roving-tabindex + aria wiring stays in one place.`,
      );
      hits += 1;
    } else {
      grandfathered += count;
    }
  }

  if (hits > 0) {
    console.error(`\n✗ ${hits} file(s) with a non-primitive role="tablist".`);
    process.exit(1);
  }
  console.log(
    `✓ tablist ratchet clean — ${owned} in the Tabs/UrlTabs primitives, ${grandfathered} grandfathered. New hand-rolled tablists fail.`,
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-tablist-ratchet.ts") ||
    process.argv[1].endsWith("check-tablist-ratchet.js") ||
    import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/")}`);

if (isMain) {
  runScan();
}
