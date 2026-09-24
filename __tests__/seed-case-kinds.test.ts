// Seed-side fence: a seed script may only open a case of a kind the
// application actually implements.
//
// THE DEFECT THIS TEST EXISTS TO PREVENT (staging measurement 2026-08-01)
// ----------------------------------------------------------------------
// scripts/seed-panorama.ts opened cases with `caseKind: "rabies_observation"`
// — a string that is NOT a member of CASE_KINDS. Because it is not a real
// kind it has no lifecycle (src/modules/cases/domain/lifecycles/), no
// attachment rules (lib/infra/case-attachment.ts), and — the part that
// actually hurt — no closer. The three paths that end a rabies observation
// (owner-close, professional-close, the close-rabies-observations cron) all
// resolve their case through `findOpenBiteCase`, which is hardcoded to
// `case_kind = 'bite_incident'`. So the cron would correctly end the
// observation on the spine and on `pets.rabies_observation_status`, find no
// `bite_incident` case, and leave the seed's `rabies_observation` row
// `status='open'` FOREVER.
//
// Measured on staging that day: 12 open `rabies_observation` cases, 1 pet
// actually under observation, ZERO overlap — every one of the 12 already had
// its `rabies_observation_ended` event (author_role='system', i.e. the cron
// fired and did its job) and ZERO `bite_incident` cases to close.
//
// The rule this pins is deliberately narrow and mechanical: whatever kinds a
// seed opens, the app must implement them. `case_kind` is unconstrained text
// in the DB precisely so no migration is needed to add a kind — which also
// means nothing but this fence stops a typo or an invented kind from becoming
// an immortal open case.

import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CASE_KINDS } from "@/src/modules/cases/domain/case-kinds";

const ROOT = resolve(__dirname, "..");

/** `caseKind: "some_literal"` — the only shape the seeds use to open a case. */
const CASE_KIND_LITERAL = /caseKind:\s*"([a-z_]+)"/g;

type Occurrence = { file: string; line: number; kind: string };

function collectSeedCaseKinds(): Occurrence[] {
  const files = globSync("scripts/**/*.ts", { cwd: ROOT });
  const found: Occurrence[] = [];

  for (const relative of files) {
    const source = readFileSync(resolve(ROOT, relative), "utf8");
    const lines = source.split("\n");
    lines.forEach((text, index) => {
      for (const match of text.matchAll(CASE_KIND_LITERAL)) {
        found.push({ file: relative, line: index + 1, kind: match[1] });
      }
    });
  }

  return found;
}

describe("seed scripts only open case kinds the application implements", () => {
  const occurrences = collectSeedCaseKinds();

  it("finds case-kind literals to check (guards against the regex silently rotting)", () => {
    // If a refactor changes how seeds spell the field, this fence would pass
    // vacuously forever. Pin that it still sees the seeds it is meant to police.
    expect(occurrences.length).toBeGreaterThan(5);
    expect(new Set(occurrences.map((o) => basename(o.file)))).toContain("seed-panorama.ts");
  });

  it("every case kind a seed opens is a member of CASE_KINDS", () => {
    const known = new Set<string>(CASE_KINDS);
    const offenders = occurrences.filter((o) => !known.has(o.kind));

    expect(
      offenders.map((o) => `${o.file}:${o.line} → "${o.kind}"`),
      "A seed opened a case of a kind the app does not implement. Such a case has no " +
        "lifecycle and no closer, so it stays status='open' forever and inflates every " +
        "counter that reads it. Use a kind from CASE_KINDS (for a rabies observation " +
        "that is 'bite_incident' — see its lifecycle's terminalEvents).",
    ).toEqual([]);
  });

  it("the rabies observation is seeded as bite_incident — the kind that has a closer", () => {
    // Named explicitly (not just covered by the generic rule above) because this
    // is the exact regression: the closers resolve their case via
    // findOpenBiteCase → case_kind='bite_incident'. A rabies case seeded as any
    // other kind is unclosable by construction.
    const panorama = occurrences.filter((o) => o.file.endsWith("seed-panorama.ts"));
    expect(panorama.map((o) => o.kind)).toContain("bite_incident");
    expect(panorama.map((o) => o.kind)).not.toContain("rabies_observation");
  });
});
