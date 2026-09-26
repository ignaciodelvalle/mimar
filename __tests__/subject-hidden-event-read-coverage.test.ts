// The owner-path reads of pet_events that must hide the denuncia bridge
// events (privacy audit W3 + S1).
//
// A denuncia writes bridge events on the denounced animal carrying the
// reporter, the relato and the exact point. RLS hides them from the owner,
// but these reads run on the service connection, so each must carry
// notHiddenFromSubjectClause (lib/infra/subject-hidden-events.ts). The audit
// found four that did not: the printable libreta export, the vet share link,
// the owner's event detail page and its loader — each an owner-reachable copy
// of the relato. This pins the set, and that the one clause is the shared one.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Owner-facing reads of pet_events that must never return a bridge event. */
const MUST_HIDE: readonly string[] = [
  "app/(app)/mis-mascotas/[publicToken]/eventos/[eventId]/page.tsx",
  "app/api/mis-mascotas/[publicToken]/libreta-export/route.ts",
  "lib/infra/libreta-share-events.ts", // the /libreta/compartir share read
  "src/modules/events/application/read/load-pet-event-detail.ts",
  "src/modules/pets/application/tab-data/get-libreta-face-data.ts",
];

const CALL = "notHiddenFromSubjectClause()";

describe("owner-path pet_events reads hide denuncia bridge events", () => {
  for (const file of MUST_HIDE) {
    it(`${file} carries the shared clause`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src, `${file} reads pet_events`).toMatch(/\bpetEvents\b/);
      expect(src).toContain(CALL);
      expect(src).toContain('from "@/lib/infra/subject-hidden-events"');
    });
  }

  it("no module keeps a private copy of the clause", () => {
    const libreta = readFileSync(
      join(ROOT, "src/modules/pets/application/tab-data/get-libreta-face-data.ts"),
      "utf8",
    );
    expect(libreta).not.toMatch(/function notHiddenCaseClause/);
  });
});
