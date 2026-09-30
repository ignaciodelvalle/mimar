// Flat JSON export of the travel reference data's provenance (viajes-fase-2,
// design D6). NOT a gate — it never fails on content.
//
// One line per datum: its path, source URL, last verification date, review
// date and verification state. The scheduled re-verification job (which lives
// in the private operations repo and only READS this repository) runs this to
// know which sources to fetch and which rules are about to expire. It never
// writes here: a person makes the public data commit that bumps
// `lastVerifiedAt`.
//
// Run:  pnpm tsx scripts/travel-reference-json.ts > travel-reference.json

import { SHIPPED_REGISTRY, referenceEntries } from "./check-travel-reference-freshness";

export type TravelReferenceRow = {
  path: string;
  kind: "country" | "airline";
  sourceUrl: string | null;
  lastVerifiedAt: string | null;
  reviewBy: string | null;
  verification: "verified" | "unverified" | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function travelReferenceRows(): TravelReferenceRow[] {
  return referenceEntries(SHIPPED_REGISTRY).map((entry) => {
    const verification = entry.meta.verification;
    return {
      path: entry.path,
      kind: entry.kind,
      sourceUrl: asString(entry.meta.sourceUrl),
      lastVerifiedAt: asString(entry.meta.lastVerifiedAt),
      reviewBy: asString(entry.meta.reviewBy),
      verification:
        verification === "verified" || verification === "unverified" ? verification : null,
    };
  });
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /travel-reference-json\.(?:ts|js)$/.test(process.argv[1].replaceAll("\\", "/"));

if (isMain) {
  process.stdout.write(`${JSON.stringify(travelReferenceRows(), null, 2)}\n`);
}
